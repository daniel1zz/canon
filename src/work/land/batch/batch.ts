import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../../workspace.ts";
import { addWorktree, git, isClean, pruneWorktrees, removeWorktree } from "../../../kernel/git.ts";
import { isGone } from "../../claims/liveness.ts";
import { runFloor, floorSkip } from "../checks/floor.ts";
import { verifyChange } from "../checks/steps.ts";
import { afterLand, closeSubject, finishLanding, moveMain, reopen } from "../finish/finish.ts";
import type { LandOptions, LandOutcome, Running } from "../outcome.ts";
import { batchCandidates, finishEntry, holdsTurn, joinBatch, landBatched, leaveBatch, lockBatch, unlockBatch } from "../queue/queue.ts";
import { lostTurn, priorityNow } from "../queue/wait.ts";
import { ownDiffId, rebaseInProgress } from "../worktree-state.ts";

/** The temporary worktree a batch led by queue entry `entry` is tested in. */
export const batchDir = (ws: Workspace, entry: number) => join(dirname(ws.db.db.filename), "batch", String(entry));

/** One change in a batch: its queue entry, and the chain commit below it (`base`) and its own top commit (`head`). */
interface Link {
  readonly entry: number;
  readonly subject: string | null;
  readonly worktree: string;
  readonly branch: string;
  /** The member's HEAD when it joined; its worktree must still be there when main moves (BR-2106). */
  readonly joined: string;
  /** The change's branch before it was rebased for this landing: what its pass records were computed on (BR-2244). */
  readonly before: string;
  readonly base: string;
  readonly head: string;
}

/**
 * The batch at this lander's turn (BR-2172, D-26). Takes up to `land_batch_max - 1` entries right behind it,
 * rebases them one after another onto this landing's own rebased HEAD in a temporary worktree, runs each
 * change's own steps on its part of the chain and the floor once on the top, and moves main to the top.
 * Returns undefined when nothing joined or the batch fell back (members go back to wait and land on their own,
 * BR-2173); "landed" when main moved; a refusal only for main moving or the turn being lost meanwhile.
 */
export async function landBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running; base: string; head: string; before: string }): Promise<{ kind: "landed" } | { kind: "refused"; reason: "main-moved" | "main-dirty" | "environment"; message: string } | { kind: "lost"; outcome: LandOutcome } | undefined> {
  const main = ws.config.main;
  const members: { id: number; subject: string | null; worktree: string; branch: string; joined: string }[] = [];
  for (const c of batchCandidates(ws.db, t.entry, ws.config.landBatchMax - 1, ws.config.landerStaleMs, priorityNow(ws))) {
    const head = git(c.worktree, "rev-parse", "HEAD");
    const branch = git(c.worktree, "rev-parse", "--abbrev-ref", "HEAD");
    const clean = isClean(c.worktree);
    if (!head.ok || !branch.ok || !clean.ok || !clean.value) break;
    if (!joinBatch(ws.db, t.entry, c.id, head.value)) break;
    members.push({ id: c.id, subject: c.subject, worktree: c.worktree, branch: branch.value, joined: head.value });
  }
  if (members.length === 0) return undefined;
  const leave = (from: number, solo: boolean) => {
    for (const m of members.slice(from)) leaveBatch(ws.db, m.id, solo);
  };
  const names = (list: readonly { subject: string | null; id: number }[]) => list.map((m) => m.subject ?? `entry ${m.id}`).join(", ");

  const dir = batchDir(ws, t.entry);
  rmSync(dir, { recursive: true, force: true });
  pruneWorktrees(ws.primary);
  const added = addWorktree(ws.primary, "-q", "--detach", dir, t.head);
  if (!added.ok) {
    leave(0, false);
    say(`batch: could not create a worktree to test in (${added.error.message.split("\n")[0]}); landing alone`);
    return undefined;
  }
  try {
    const links: Link[] = [{ entry: t.entry, subject: t.subject, worktree: ws.root, branch: t.branch, joined: t.head, before: t.before, base: t.base, head: t.head }];
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const prev = links[links.length - 1]!.head;
      const from = git(ws.primary, "merge-base", t.base, m.joined);
      const reb = from.ok ? git(dir, "rebase", "-q", "--onto", prev, from.value, m.joined) : from;
      const top = reb.ok ? git(dir, "rev-parse", "HEAD") : reb;
      if (!top.ok) {
        // reason: a change that conflicts with the ones ahead of it in the batch is not judged here; it and the ones behind it wait for their own turn (BR-2172).
        if (rebaseInProgress(dir)) git(dir, "rebase", "--abort");
        say(`batch: ${names(members.slice(i))} do not rebase onto the batch; they wait for their own turn`);
        leave(i, false);
        members.splice(i);
        break;
      }
      links.push({ entry: m.id, subject: m.subject, worktree: m.worktree, branch: m.branch, joined: m.joined, before: m.joined, base: prev, head: top.value });
    }
    if (members.length === 0) return undefined;
    const tip = links[links.length - 1]!.head;
    say(`batch: testing ${names(members)} together with ${t.subject ?? "this landing"} (floor once on ${tip.slice(0, 9)})`);
    ws.db.event(ws.actor, "batch.start", t.subject, { entry: t.entry, members: links.slice(1).map((l) => ({ entry: l.entry, change: l.subject, head: l.head })) });

    const fallBack = (why: string) => {
      leave(0, true);
      ws.db.event(ws.actor, "batch.fail", t.subject, { entry: t.entry, why: why.slice(0, 2000), members: links.slice(1).map((l) => l.entry) });
      say(`batch: ${why.split("\n")[0]}; ${names(members)} go back to the queue to land on their own, and ${t.subject ?? "this landing"} goes on alone`);
      return undefined;
    };

    if (ws.config.setup) {
      // reason: run without blocking, so the heartbeat timer and the signal handler keep running through a slow setup (BR-2049, BR-2099, issue #60).
      const setup = Bun.spawn(["sh", "-c", ws.config.setup], { cwd: dir, stdout: "ignore", stderr: "ignore" });
      t.running.floor = setup;
      const code = await setup.exited;
      t.running.floor = undefined;
      if (code !== 0) return fallBack(`setup exited ${code} in the batch worktree`);
    }
    const notes: Record<number, Awaited<ReturnType<typeof verifyChange>>> = {};
    for (const l of links) {
      const co = git(dir, "checkout", "-q", "--detach", l.head);
      if (!co.ok) return fallBack(`checkout of ${l.head.slice(0, 9)} failed: ${co.error.message}`);
      // reason: the whole batch moves main at once, so every member is compared with main, not the member before it (BR-2248)
      const steps = await verifyChange(ws, opts, say, { wt: dir, base: l.base, main: t.base, head: l.head, before: l.before, subject: l.subject, branch: l.branch });
      if (!steps.ok) return fallBack(`${l.subject ?? `entry ${l.entry}`} was refused in the batch (${steps.reason})`);
      notes[l.entry] = steps;
    }
    const co = git(dir, "checkout", "-q", "--detach", tip);
    if (!co.ok) return fallBack(`checkout of ${tip.slice(0, 9)} failed: ${co.error.message}`);
    const skip = floorSkip(dir, t.base, tip);
    if (skip) {
      say(`floor: skipped — all ${skip.paths.length} changed path(s) of the batch are under floor_skip_paths (${skip.under.join(", ")})`);
      ws.db.event(ws.actor, "floor.skip", t.subject, { entry: t.entry, paths: skip.paths.slice(0, 50), under: skip.under });
    } else {
      const floor = await runFloor(ws, say, dir, `land-${t.entry}-batch.log`, t.running);
      if (floor.code !== 0) return fallBack(`the floor failed on the batch (exit ${floor.code}, log: ${floor.log})`);
    }

    // Every member's worktree is as it joined and the entry is still in this batch, and this lander still holds
    // its turn: otherwise what was tested is not what would land (BR-2106, BR-2144).
    for (const l of links) {
      const now = git(l.worktree, "rev-parse", "HEAD");
      const clean = isClean(l.worktree);
      if (!now.ok || now.value !== l.joined || !clean.ok || !clean.value) return fallBack(`the worktree of ${l.subject ?? `entry ${l.entry}`} changed during the batch`);
    }
    const memberIds = links.slice(1).map((l) => l.entry);
    const turn = holdsTurn(ws.db, t.entry);
    if (!turn.held) {
      leave(0, false);
      return { kind: "lost", outcome: lostTurn(ws, t.subject, ws.root, turn.state, "before-main") };
    }
    const fingerprints = new Map(links.map((l) => [l.entry, ownDiffId(l.worktree, main)]));
    // reason: all members are locked in at once, after the last check, so none can give its entry up while main moves (issue #42).
    if (!lockBatch(ws.db, t.entry, memberIds)) return fallBack("a member left the batch (its lander stopped)");
    const moved = moveMain(ws, t.base, tip);
    if (moved !== "moved") {
      unlockBatch(ws.db, t.entry, memberIds);
      for (const l of links.slice(1)) reopenForGoneLander(ws, l, say);
      return { kind: "refused", reason: moved.reason, message: moved.message };
    }
    // reason: members are recorded landed before the leader, so a member never sees its leader done while it is still batched (BR-2172).
    for (const l of links.slice(1)) landBatched(ws.db, l.entry, l.head);
    finishEntry(ws.db, t.entry, "landed", t.head);
    for (const l of links) {
      const n = notes[l.entry];
      const reviewNotes = n?.ok ? n.reviewNotes : undefined;
      ws.db.event(ws.actor, "land.ok", l.subject, { sha: l.head, base: l.base, branch: l.branch, diff: fingerprints.get(l.entry) ?? null, ...(reviewNotes ?? {}), ...(skip ? { floor_skipped: true } : {}), ...(l.entry !== t.entry ? { batched_by: t.entry } : { batch: links.slice(1).map((x) => x.entry) }) });
      say(`landed ${l.head.slice(0, 9)} (${l.subject ?? `entry ${l.entry}`}) on ${main}`);
    }
    for (const l of links) afterLand(ws, say, { entry: l.entry, subject: l.subject, base: l.base, head: l.head, branch: l.branch });
    return { kind: "landed" };
  } finally {
    removeWorktree(ws.primary, "--force", dir);
  }
}

/**
 * After a batch was locked but main did not move: a member whose lander process is gone (a signal ended it while
 * it was locked, so it left its close commit, BR-2099) gets its close commit taken back here, as its own landing
 * would have done (BR-2018). A live member reopens it itself if its own landing later fails.
 */
export function reopenForGoneLander(ws: Workspace, l: { entry: number; subject: string | null; worktree: string }, say: Say): boolean {
  const row = ws.db.db.query<{ pid: number | null; pid_start: string | null }, [number]>("SELECT pid, pid_start FROM queue WHERE id = ?").get(l.entry);
  if (!l.subject || !row || row.pid === null || row.pid_start === null || isGone({ pid: row.pid, start: row.pid_start }) !== true) return false;
  const top = git(l.worktree, "log", "-1", "--format=%s");
  const files = git(l.worktree, "-c", "core.quotePath=false", "diff", "--name-only", "HEAD~1", "HEAD");
  if (!top.ok || top.value !== closeSubject(l.subject) || !files.ok || files.value.includes("\n")) return false;
  return reopen(l.worktree, { subject: l.subject, path: files.value }, say);
}

/**
 * A member of another lander's batch whose change that lander landed (BR-2172): its own branch moves by a
 * compare-and-swap from the HEAD it joined with to its commit on main, and its files follow; then it finishes
 * like any landing. A commit made in the worktree meanwhile stays, and the message says how to catch up.
 */
export function landedInBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null }, by: { leader: number; sha: string; head: string }): LandOutcome {
  const wt = ws.root;
  const main = ws.config.main;
  say(`landed ${by.sha.slice(0, 9)} on ${main} in the batch of queue entry ${by.leader}`);
  const cas = git(wt, "update-ref", "-m", `canon: landed in batch ${by.leader}`, "HEAD", by.sha, by.head);
  if (!cas.ok) say(`this worktree's branch moved after it joined the batch, so it was left as it is; \`git rebase ${main}\` brings it up to date`);
  else if (!git(wt, "read-tree", "-m", "-u", by.head, by.sha).ok) {
    git(wt, "update-ref", "-m", "canon: keep the branch as it was", "HEAD", by.head, by.sha);
    say(`local edits keep this worktree's files from following the landed commit; the branch was left as it is; \`git rebase ${main}\` brings it up to date`);
  }
  return finishLanding(ws, opts, say, { entry: t.entry, subject: t.subject, sha: by.sha });
}
