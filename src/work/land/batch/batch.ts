import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../../workspace.ts";
import { addWorktree, type BranchMoveFailure, git, isClean, moveBranch, pruneWorktrees, removeWorktree } from "../../../kernel/git.ts";
import { isGone } from "../../claims/liveness.ts";
import { runFloor, floorSkip } from "../checks/floor.ts";
import { verifyChange, type StepFailure, type Steps } from "../checks/steps.ts";
import { afterLand, closeSubject, finishLanding, moveMain, reopen } from "../finish/finish.ts";
import type { LandOptions, LandOutcome, Running } from "../outcome.ts";
import { batchCandidates, finishEntry, holdsTurn, inBatch, joinBatch, landBatched, leaveBatch, lockBatch, refuseInBatch, unlockBatch } from "../queue/queue.ts";
import { lostTurn, priorityNow } from "../queue/wait.ts";
import { ownDiffId, rebaseInProgress } from "../worktree-state.ts";
import { closeRetired } from "../../../knowledge/review/findings/findings.ts";

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
 * Why a member left a batch without landing in it (`batch.drop`, BR-2378): a fixed set, so `canon stats` can count them.
 * `steps` and `rebase` are the member's own; `floor` is the change whose addition made the floor fail; `behind` is sent
 * back only because one ahead of it left; `changed` is a worktree that moved after joining; `lander-gone` is a member
 * whose lander ended; `leader-refused` and `leader-lost-turn` end the batch for the leader; `batch-failed` is a batch
 * that could not be tested or locked (see `batch.fail`); `main-not-moved` is a lost compare-and-swap on main.
 */
export type DropReason = "steps" | "rebase" | "floor" | "behind" | "changed" | "lander-gone" | "leader-refused" | "leader-lost-turn" | "batch-failed" | "main-not-moved";

/** What a batch did for its leader (BR-2172, BR-2173). */
export type BatchOutcome =
  | { readonly kind: "landed" }
  | { readonly kind: "refused"; readonly reason: Extract<LandOutcome, { kind: "refused" }>["reason"]; readonly message: string; readonly findings?: StepFailure["findings"] }
  | { readonly kind: "lost"; readonly outcome: LandOutcome };

/**
 * The batch at this lander's turn (BR-2172, D-26, D-42). Takes the entries right behind it (up to `land_batch_max`
 * in all), and in a temporary worktree builds a chain: this landing's own rebased HEAD, then each member rebased onto
 * the one before. Each change's own steps run on its part of the chain as it is added; a member they refuse leaves
 * the chain and goes back to the queue, so it is judged again later, on a base that may by then hold what it needs.
 * The floor runs once on the top; when it fails, the shortest failing prefix of the chain is found by testing
 * prefixes (BR-2173): the change whose addition makes it fail is refused, the passing prefix lands, and the ones
 * after it go back to the queue. Returns undefined when nothing joined or the batch could not be tested at all
 * (the leader then lands alone); "refused" when the leader itself is refused.
 */
export async function landBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running; base: string; head: string; before: string }): Promise<BatchOutcome | undefined> {
  const main = ws.config.main;
  const deletesConfig = (cwd: string, head: string) => {
    const d = git(cwd, "diff", "--name-only", "--diff-filter=D", t.base, head, "--", "canon/config.yaml");
    return !d.ok || d.value !== "";
  };
  if (deletesConfig(ws.root, t.head)) return undefined;
  const members: { id: number; subject: string | null; worktree: string; branch: string; joined: string }[] = [];
  for (const c of batchCandidates(ws.db, t.entry, ws.config.landBatchMax - 1, ws.config.landerStaleMs, priorityNow(ws))) {
    const head = git(c.worktree, "rev-parse", "HEAD");
    const branch = git(c.worktree, "rev-parse", "--abbrev-ref", "HEAD");
    const clean = isClean(c.worktree);
    if (!head.ok || !branch.ok || !clean.ok || !clean.value || deletesConfig(c.worktree, head.value)) break;
    if (!joinBatch(ws.db, t.entry, c.id, head.value)) break;
    members.push({ id: c.id, subject: c.subject, worktree: c.worktree, branch: branch.value, joined: head.value });
  }
  if (members.length === 0) return undefined;
  const sentBack: { entry: number; reason: DropReason }[] = [];
  let landedMembers: number[] = [];
  let run = 0;
  let ended = false;
  // One `batch.end` per batch that started, whichever way it ended (BR-2378); a leader killed mid-batch leaves a `batch.start` without it.
  const end = (leader: "landed" | "refused" | "lost-turn" | "alone" | "error", reason?: string) => {
    if (ended) return;
    ended = true;
    ws.db.event(ws.actor, "batch.end", t.subject, { entry: t.entry, leader, ...(reason ? { reason } : {}), landed: landedMembers, sent_back: sentBack, floors: run });
  };
  const name = (m: { subject: string | null; entry?: number; id?: number }) => m.subject ?? `entry ${m.entry ?? m.id}`;
  const names = (list: readonly { subject: string | null; id?: number; entry?: number }[]) => list.map(name).join(", ");
  // Every member that leaves the batch without landing goes through here, so none leaves silently (BR-2378).
  const noteDrop = (m: { id?: number; entry?: number }, reason: DropReason, extra: Record<string, unknown> = {}) => {
    const entry = (m.id ?? m.entry)!;
    if (sentBack.some((x) => x.entry === entry)) return false; // a member leaves once, whichever exit reaches it first
    ws.db.event(ws.actor, "batch.drop", members.find((x) => x.id === entry)?.subject ?? null, { entry, leader: t.entry, reason, ...extra });
    sentBack.push({ entry, reason });
    return true;
  };
  const sendBack = (list: readonly { id?: number; entry?: number }[], reason: DropReason, extra: Record<string, unknown> = {}) => {
    for (const m of list) {
      leaveBatch(ws.db, (m.id ?? m.entry)!);
      noteDrop(m, reason, extra);
    }
  };

  ws.db.event(ws.actor, "batch.start", t.subject, { entry: t.entry, members: members.map((m) => ({ entry: m.id, change: m.subject })) });
  const dir = batchDir(ws, t.entry);
  rmSync(dir, { recursive: true, force: true });
  pruneWorktrees(ws.primary);
  const added = addWorktree(ws.primary, "-q", "--detach", dir, t.head);
  if (!added.ok) {
    sendBack(members, "batch-failed");
    end("alone", "no-worktree");
    say(`batch: could not create a worktree to test in (${added.error.message.split("\n")[0]}); landing alone`);
    return undefined;
  }
  try {
    say(`batch: testing ${names(members)} together with ${t.subject ?? "this landing"}`);
    // The batch cannot be tested at all: every member goes back to the queue and this landing goes on alone (BR-2173).
    const giveUp = (why: string, reason: string) => {
      sendBack(members, "batch-failed");
      end("alone", reason);
      ws.db.event(ws.actor, "batch.fail", t.subject, { entry: t.entry, why: why.slice(0, 2000), members: members.map((m) => m.id) });
      say(`batch: ${why.split("\n")[0]}; ${names(members)} go back to the queue, and ${t.subject ?? "this landing"} goes on alone`);
      return undefined;
    };
    if (ws.config.setup) {
      // reason: run without blocking, so the heartbeat timer and the signal handler keep running through a slow setup (BR-2049, BR-2099, issue #60).
      // reason: the batch worktree belongs to no single change, so its setup gets no port, not the one canon was run with (BR-2267, D-48).
      const setup = Bun.spawn(["sh", "-c", ws.config.setup], { cwd: dir, env: { ...(process.env as Record<string, string>), CANON_PORT: "" }, stdout: "ignore", stderr: "ignore" });
      t.running.floor = setup;
      const code = await setup.exited;
      t.running.floor = undefined;
      if (code !== 0) return giveUp(`setup exited ${code} in the batch worktree`, "setup");
    }

    const notes = new Map<number, Steps>();
    const check = async (l: Link): Promise<Steps> => {
      const co = git(dir, "checkout", "-q", "--detach", l.head);
      if (!co.ok) return { ok: false, reason: "environment", message: `checkout of ${l.head.slice(0, 9)} failed: ${co.error.message}` };
      // reason: the whole batch moves main at once, so every member is compared with main, not the member before it (BR-2248)
      return verifyChange(ws, opts, say, { wt: dir, base: l.base, main: t.base, head: l.head, before: l.before, subject: l.subject, branch: l.branch, running: t.running, worktree: l.worktree });
    };
    // The leader's own steps first: they are exactly what it would get landing alone (BR-2173).
    const leader: Link = { entry: t.entry, subject: t.subject, worktree: ws.root, branch: t.branch, joined: t.head, before: t.before, base: t.base, head: t.head };
    const own = await check(leader);
    if (!own.ok) {
      sendBack(members, "leader-refused");
      end("refused", own.reason);
      say(`batch: ${name(leader)} was refused (${own.reason}); ${names(members)} go back to the queue`);
      return { kind: "refused", reason: own.reason, message: own.message, ...(own.findings ? { findings: own.findings } : {}) };
    }
    notes.set(t.entry, own);
    const links: Link[] = [leader];
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const prev = links[links.length - 1]!.head;
      const from = git(ws.primary, "merge-base", t.base, m.joined);
      const co = git(dir, "checkout", "-q", "--detach", prev);
      const reb = !co.ok ? co : from.ok ? git(dir, "rebase", "-q", "--onto", prev, from.value, m.joined) : from;
      const top = reb.ok ? git(dir, "rev-parse", "HEAD") : reb;
      if (!top.ok) {
        // reason: a change that conflicts with the ones ahead of it in the batch is not judged here; it waits for its own turn (BR-2172).
        if (rebaseInProgress(dir)) git(dir, "rebase", "--abort");
        say(`batch: ${name(m)} does not rebase onto the batch; it goes back to the queue`);
        sendBack([m], "rebase");
        continue;
      }
      const link: Link = { entry: m.id, subject: m.subject, worktree: m.worktree, branch: m.branch, joined: m.joined, before: m.joined, base: prev, head: top.value };
      const steps = await check(link);
      if (!steps.ok) {
        // reason: its refusal here may depend on changes ahead of it that are not on main yet, and the review is a sample;
        // it is judged again on its own turn or in a later batch, and no other member is affected (BR-2173, D-42).
        say(`batch: ${name(m)} was refused in the batch (${steps.reason}); it goes back to the queue, the others go on`);
        sendBack([m], "steps", { step: steps.reason });
        continue;
      }
      notes.set(m.id, steps);
      links.push(link);
    }

    // Settle on the longest prefix of the chain whose top passed the floor; `passed` holds the prefix lengths tested green.
    const passed = new Set<number>();
    let n = links.length;
    const floorOn = async (len: number): Promise<{ ok: boolean; log: string; skipped: boolean }> => {
      const tip = links[len - 1]!.head;
      const co = git(dir, "checkout", "-q", "--detach", tip);
      if (!co.ok) return { ok: false, log: co.error.message, skipped: false };
      const skip = floorSkip(dir, t.base, tip, say);
      if (skip) {
        say(`floor: skipped — all ${skip.paths.length} changed path(s) of the batch are under floor_skip_paths (${skip.under.join(", ")})`);
        ws.db.event(ws.actor, "floor.skip", t.subject, { entry: t.entry, paths: skip.paths.slice(0, 50), under: skip.under });
        return { ok: true, log: "", skipped: true };
      }
      run++;
      if (len > 1) say(`batch: floor on ${names(links.slice(0, len))} (${tip.slice(0, 9)})`);
      const floor = await runFloor(ws, say, dir, `land-${t.entry}-batch${run > 1 ? `-${run}` : ""}.log`, t.running);
      return { ok: floor.code === 0, log: `floor exited ${floor.code} (full log: ${floor.log})\n${floor.tail}`, skipped: false };
    };
    let skipped = false;
    for (;;) {
      const top = await floorOn(n);
      skipped = top.skipped;
      if (!top.ok) {
        // Binary search for the shortest failing prefix: the change at its top is the one whose addition fails (BR-2173).
        let lo = 0;
        let hi = n; // prefix length n fails
        let failLog = top.log;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          const r = await floorOn(mid);
          if (r.ok) {
            passed.add(mid);
            lo = mid;
          } else {
            hi = mid;
            failLog = r.log;
          }
        }
        const culprit = links[hi - 1]!;
        ws.db.event(ws.actor, "batch.fail", t.subject, { entry: t.entry, why: `the floor failed once ${name(culprit)} joined`, members: links.slice(1).map((l) => l.entry), culprit: culprit.entry, floors: run });
        if (hi === 1) {
          sendBack(links.slice(1).map((l) => ({ entry: l.entry })), "leader-refused");
          end("refused", "floor");
          return { kind: "refused", reason: "floor", message: failLog };
        }
        sendBack(links.slice(hi).map((l) => ({ entry: l.entry })), "behind", { culprit: culprit.entry });
        noteDrop({ entry: culprit.entry }, "floor"); // refused below, so it does not go back to waiting
        refuseInBatch(ws.db, t.entry, culprit.entry, `the floor failed once ${name(culprit)} joined the batch of ${name(leader)}:\n${failLog}`);
        say(`batch: the floor fails once ${name(culprit)} joins; it is refused, ${links.length > hi ? `${names(links.slice(hi))} go back to the queue, ` : ""}${names(links.slice(0, hi - 1))} land`);
        n = hi - 1;
        if (!passed.has(n)) continue;
      } else passed.add(n);

      // Every member's worktree is as it joined and the entry is still in this batch: otherwise what was tested is
      // not what would land (BR-2106). A member that changed goes back with the ones after it; the rest is tested again.
      const mine = git(ws.root, "rev-parse", "HEAD");
      const mineClean = isClean(ws.root);
      if (!mine.ok || mine.value !== t.head || !mineClean.ok || !mineClean.value) {
        sendBack(links.slice(1, n).map((l) => ({ entry: l.entry })), "leader-refused");
        end("refused", "moved-during-land");
        return { kind: "refused", reason: "moved-during-land", message: `the worktree changed during the batch, so what was tested is not what would land; ${names(links.slice(1, n))} went back to the queue; land again` };
      }
      const changed = links.slice(1, n).findIndex((l) => {
        const now = git(l.worktree, "rev-parse", "HEAD");
        const clean = isClean(l.worktree);
        return !now.ok || now.value !== l.joined || !clean.ok || !clean.value || !inBatch(ws.db, l.entry, t.entry);
      });
      if (changed === -1) break;
      const at = changed + 1;
      say(`batch: ${name(links[at]!)} changed or left during the batch; it ${n - at > 1 ? `and ${names(links.slice(at + 1, n))} go` : "goes"} back to the queue`);
      const first = links[at]!;
      sendBack([{ entry: first.entry }], inBatch(ws.db, first.entry, t.entry) ? "changed" : "lander-gone");
      sendBack(links.slice(at + 1, n).map((l) => ({ entry: l.entry })), "behind", { because: first.entry });
      n = at;
      if (passed.has(n)) break;
    }
    const landing = links.slice(0, n);
    const rest = links.slice(n);
    const tip = landing[landing.length - 1]!.head;
    const memberIds = landing.slice(1).map((l) => l.entry);
    const turn = holdsTurn(ws.db, t.entry);
    if (!turn.held) {
      sendBack(landing.slice(1).map((l) => ({ entry: l.entry })), "leader-lost-turn");
      end("lost-turn");
      return { kind: "lost", outcome: lostTurn(ws, t.subject, ws.root, turn.state, "before-main") };
    }
    const fingerprints = new Map(landing.map((l) => [l.entry, ownDiffId(l.worktree, main)]));
    // reason: all members are locked in at once, after the last check, so none can give its entry up while main moves (issue #42).
    if (!lockBatch(ws.db, t.entry, memberIds)) {
      return giveUp("a member left the batch (its lander stopped)", "lock");
    }
    const moved = moveMain(ws, t.base, tip);
    if (moved !== "moved") {
      unlockBatch(ws.db, t.entry, memberIds);
      for (const l of landing.slice(1)) {
        reopenForGoneLander(ws, l, say);
        noteDrop({ entry: l.entry }, "main-not-moved");
      }
      end("refused", moved.reason);
      return { kind: "refused", reason: moved.reason, message: moved.message };
    }
    // reason: members are recorded landed before the leader, so a member never sees its leader done while it is still batched (BR-2172).
    for (const l of landing.slice(1)) landBatched(ws.db, l.entry, l.head);
    finishEntry(ws.db, t.entry, "landed", t.head);
    landedMembers = memberIds;
    end("landed");
    const landedAt = new Map<number, number>();
    for (const l of landing) {
      const s = notes.get(l.entry);
      const landed = ws.db.event(ws.actor, "land.ok", l.subject, { sha: l.head, base: l.base, branch: l.branch, diff: fingerprints.get(l.entry) ?? null, ...(skipped ? { floor_skipped: true } : {}), ...(l.entry !== t.entry ? { batched_by: t.entry } : { batch: landing.slice(1).map((x) => x.entry), floors: run }) });
      // Open review findings naming a document retired or superseded on this member's tree are closed by its landing (BR-2435).
      if (s?.ok) closeRetired(ws.db, new Set(s.retired), landed);
      landedAt.set(l.entry, landed);
      say(`landed ${l.head.slice(0, 9)} (${name(l)}) on ${main}`);
    }
    if (rest.length > 0) say(`batch: ${names(rest)} were not landed with it`);
    for (const l of landing) {
      const s = notes.get(l.entry);
      afterLand(ws, say, { entry: l.entry, subject: l.subject, base: l.base, head: l.head, branch: l.branch, landed: landedAt.get(l.entry)!, review: s?.ok ? s.review : undefined });
    }
    return { kind: "landed" };
  } finally {
    end("error"); // an exception ended the batch without an outcome; the throw itself carries the cause
    removeWorktree(ws.primary, "--force", dir);
  }
}

/**
 * After a batch was locked but main did not move: a member whose lander process is gone (a signal ended it while
 * it was locked, so it left its close commit, BR-2099) gets its close commit taken back here, as its own landing
 * would have done (BR-2018). A live member reopens it itself: a signalled one waits in its handler until it is
 * unlocked and then takes it back (BR-2099, issue #43), any other one when its own landing later fails.
 */
export function reopenForGoneLander(ws: Workspace, l: { entry: number; subject: string | null; worktree: string }, say: Say): boolean {
  const row = ws.db.db.query<{ pid: number | null; pid_start: string | null }, [number]>("SELECT pid, pid_start FROM queue WHERE id = ?").get(l.entry);
  if (!l.subject || !row || row.pid === null || row.pid_start === null || isGone({ pid: row.pid, start: row.pid_start }) !== true) return false;
  const top = git(l.worktree, "log", "-1", "--format=%s");
  const files = git(l.worktree, "-c", "core.quotePath=false", "diff", "--name-only", "HEAD~1", "HEAD");
  if (!top.ok || top.value !== closeSubject(l.subject) || !files.ok || files.value.includes("\n")) return false;
  return reopen(l.worktree, { subject: l.subject, path: files.value, stamped: [] }, say);
}

/** What a landed member says when its branch could not follow its commit on main (BR-2191). */
export function followHint(moved: BranchMoveFailure, main: string): string {
  if (moved.kind === "moved") return `this worktree's branch moved after it joined the batch, so it was left as it is; \`git rebase ${main}\` brings it up to date`;
  if (moved.kind === "files") return `local edits keep this worktree's files from following the landed commit; the branch was left as it is; \`git rebase ${main}\` brings it up to date`;
  // reason: a failed undo already says where HEAD and the files are, so the hint never claims they stayed (BR-2191, BR-2258).
  if (moved.kind === "undo") return `${moved.message}; \`git rebase ${main}\` brings it up to date`;
  return `${moved.message}; the branch was left as it is; \`git rebase ${main}\` brings it up to date once that git command has ended`;
}

/**
 * A member of another lander's batch whose change that lander landed (BR-2172): its own branch moves by a
 * compare-and-swap from the HEAD it joined with to its commit on main, and its index and files follow in the same step
 * under git's index lock (BR-2258); then it finishes
 * like any landing. A commit made in the worktree meanwhile stays, and the message says how to catch up.
 */
export function landedInBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null }, by: { leader: number; sha: string; head: string }): LandOutcome {
  const wt = ws.root;
  const main = ws.config.main;
  say(`landed ${by.sha.slice(0, 9)} on ${main} in the batch of queue entry ${by.leader}`);
  // reason: under git's index lock, so a commit tried while the branch moves is refused instead of recording the joined tree on top of main (BR-2258, issue #36).
  const moved = moveBranch(wt, by.head, by.sha, `canon: landed in batch ${by.leader}`);
  if (moved) say(followHint(moved, main));
  return finishLanding(ws, opts, say, { entry: t.entry, subject: t.subject, sha: by.sha });
}
