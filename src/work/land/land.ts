import { existsSync } from "node:fs";
import type { Say, Workspace } from "../workspace.ts";
import { type Finding } from "../../knowledge/check/check.ts";
import { bindToLander, keepClaim, renewClaim, unbindFromLander } from "../claims/claims.ts";
import { batchRefusal, enter, failKeepingPlace, failIfActive, finishEntry, heartbeat, holdsTurn, keptUntil, settleLocked, tryTurn } from "./queue/queue.ts";
import { selfProcess, sessionProcess } from "../claims/liveness.ts";
import { noticeOverlaps } from "../session/overlap.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { setMeta } from "../../knowledge/documents/write.ts";
import { hasLessons, LESSONS_SECTION } from "../../knowledge/documents/templates.ts";
import { git, isClean, removeWorktree } from "../../kernel/git.ts";
import { ensureWatcher, pathCanonReads, timingOf } from "../watch/watch.ts";
import { missingMessage, passesMeta, planClose } from "../execution/landing.ts";
import type { LandOptions, LandOutcome, Running } from "./outcome.ts";
import { changesIn, ownDiffId, rebaseInProgress } from "./worktree-state.ts";
import { keptNote, lostTurn, predictedConflicts, priorityNow, waitPollMs } from "./queue/wait.ts";
import { removeReviewTree } from "./checks/review-tree.ts";
import { findingDetail, verifyChange } from "./checks/steps.ts";
import { floorSkip, runFloor } from "./checks/floor.ts";
import { afterLand, closeLeftNote, closeSubject, finishLanding, moveMain, reopen, type CloseCommit } from "./finish/finish.ts";
import { batchDir, landBatch, landedInBatch } from "./batch/batch.ts";
import { pushMain } from "../remote/remote.ts";
import { settleInterrupted } from "./queue/interrupted.ts";

/** What a landing that took its kept place back says it stopped for (BR-2177, BR-2368). */
const KEPT_AFTER = { conflict: "its conflict", timeout: "its timeout", killed: "it was stopped by a signal" } as const;

/**
 * Landing (design §6): queue → rebase onto main → canon check → sources → review → before_land → floor →
 * compare-and-swap main. The only refusals are outcome guards (P4).
 */

/**
 * Lands the current worktree's branch on main: queue → rebase onto main → canon check → review → before_land → floor →
 * compare-and-swap main. Runs on the exact tree that becomes main.
 */
export async function land(ws: Workspace, opts: LandOptions, say: Say): Promise<LandOutcome> {
  const wt = ws.root;
  const main = ws.config.main;
  const renewed = renewClaim(ws.db, wt, ws.actor, ws.config.claimLeaseMs, sessionProcess());
  // reason: another session's live claim is a claim conflict (recorded as claim.refuse, exit 5), not a landing check (BR-2104).
  if (!renewed.ok) return { kind: "refused", reason: "claimed", message: renewed.error.message };
  const claim = renewed.value;
  const subject = claim?.subject ?? null;
  // A previous landing from this worktree that was killed leaves no event; it is said and cleaned up first (BR-2309, D-58).
  const recovered = settleInterrupted(ws, say);
  // The previous landing reached main and was killed before it recorded that: it is recorded now, and nothing lands again (BR-2309).
  if (recovered) return finishLanding(ws, opts, say, { entry: 0, subject, sha: recovered.sha });
  // Before anything slow, so a landing killed from here on is found by its process (BR-2307, D-58).
  const lander = selfProcess();
  ws.db.event(ws.actor, "land.start", subject, { pid: lander?.pid ?? null, pid_start: lander?.start ?? null });
  // Every refusal, early or late, is recorded with its reason so a check's precision can be measured (P6, BR-2026).
  const early = (reason: Extract<LandOutcome, { kind: "refused" }>["reason"], message: string): LandOutcome => {
    ws.db.event(ws.actor, "land.refuse", subject, { reason, message: message.slice(0, 2000), diff: ownDiffId(wt, main) });
    return { kind: "refused", reason, message };
  };
  const branch = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch.ok || branch.value === "HEAD" || branch.value === main) {
    return early("on-main", `land runs from a change worktree on its own branch, not from ${main} or a detached HEAD`);
  }
  if (!ws.config.floor) return early("no-floor", "canon/config.yaml has no `floor` command; nothing proves the tree is sound");
  const clean = isClean(wt);
  if (!clean.ok || !clean.value) return early("dirty", "the worktree has uncommitted changes; commit them first");

  let close: CloseCommit | undefined;
  let entry: number | undefined;
  let bound: ReturnType<typeof bindToLander> | undefined;
  const running: Running = {};
  // A lander killed by a signal (a tool timeout, Ctrl-C) gives its turn up at once and leaves no rebase half done (BR-2099).
  // reason: registered before the close commit, so a signal while it is made or before the landing queues still takes it back (BR-2018).
  const onSignal = (signal: NodeJS.Signals) => {
    running.floor?.kill();
    running.review?.kill(); // a reviewer left running would keep spending after the landing ended (BR-2296)
    // reason: process.exit skips the batch's finally, so its temporary worktree is removed here (BR-2099, BR-2172).
    if (running.reviewTree !== undefined) removeReviewTree(ws, running.reviewTree); // after the review's process group is stopped (BR-2216)
    if (entry !== undefined && existsSync(batchDir(ws, entry))) removeWorktree(ws.primary, "--force", batchDir(ws, entry));
    const aborted = rebaseInProgress(wt) && git(wt, "rebase", "--abort").ok;
    // A signal after main moved leaves the landed entry as it is: the landing happened.
    // reason: an interruption, not a check's verdict, so it is its own event kind and no check in `canon stats` (BR-2067).
    // reason: only while this lander still owns the entry; a later landing may have taken it back as its kept place (BR-2177, issue #45).
    if (entry === undefined) {
      // reason: BR-2307 ends a landing with land.killed; the lander never reaches this before queueing today, but an await added before enqueue would (D-58).
      ws.db.event(ws.actor, "land.killed", subject, { signal, rebaseAborted: aborted });
      if (close) reopen(wt, close, say);
    } else if (waitWhileLocked(ws, entry, say) && failIfActive(ws.db, entry, "killed", lander ?? null, ws.config.landKeepPlaceMs)) {
      // reason: the entry keeps its place for this change's next landing from this worktree, like a timeout (BR-2368, D-75).
      const until = keptUntil(ws.db, entry);
      if (until) say(`landing stopped by ${signal}; this landing keeps its place in the queue until ${until}: landing again from this worktree before then puts it back ahead of the landings queued after it`);
      ws.db.event(ws.actor, "land.killed", subject, { signal, rebaseAborted: aborted, ...(until ? { keeps_place_until: until } : {}) });
      if (close) reopen(wt, close, say);
    } else {
      // reason: a leader may have refused this entry in its batch before this lander read it; the change did not land,
      // so its close commit is taken back here as the refusal would have done (BR-2173, BR-2018, #98).
      const refused = batchRefusal(ws.db, entry);
      if (refused !== undefined) {
        ws.db.event(ws.actor, "land.refuse", subject, { reason: "floor", message: refused.slice(0, 2000), signal });
        if (close) reopen(wt, close, say);
      }
    }
    if (bound) unbindFromLander(ws.db, bound);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let out: LandOutcome | undefined;
  try {
    // The close commit lands with the work, so the tree that is tested is the tree that becomes main (BR-2106);
    // a landing that does not reach main takes it back out, so the change never says done without landing (BR-2018).
    if (opts.finish) {
      if (!subject) return early("no-claim", "--finish needs a claimed change; this worktree holds none");
      const corpus = readCorpus(wt, ws.config.types, ws.config).corpus;
      const doc = findDoc(corpus, subject);
      if (doc?.kind === "change" && doc.status === "open") {
        // reason: lessons are known when the work ends, so closing is where they are required; old closed changes stay valid (BR-2161, D-24)
        if (!hasLessons(doc.body)) return early("lessons", `${subject} has no filled ${LESSONS_SECTION} section: write each lesson this work found and where it went (a mechanism's id, 只靠文字：<原因>, or 待负责人确认是否固化), or 无 when there is none; commit, then land --finish again`);
        // reason: the evidence is known before the close commit, so a missing one refuses with no commit to take back (BR-2241, D-32)
        const planned = planClose(ws.db, ws.config, wt, ws.config.main, corpus, doc);
        if ("error" in planned) return early("environment", `the pass records could not be computed: ${planned.error}`);
        if (planned.missing.length > 0) return early("evidence", missingMessage(subject, planned.missing));
        // reason: a file write or git commit that fails is an environment error, not a check's verdict (BR-2193).
        // setMeta fails before it writes, so the file is left as it is: whatever is in it now is someone else's edit (issue #80).
        // reason: passes is replaced whole, so a record written by hand never survives the close (BR-2242)
        const s = setMeta(wt, doc, { status: "done", passes: passesMeta(planned.records) });
        if (!s.ok) return early("environment", `the close commit could not be made: ${s.error.message}`);
        git(wt, "add", doc.path);
        const c = git(wt, "commit", "-q", "-m", closeSubject(subject));
        if (!c.ok) {
          git(wt, "reset", "-q", "--", doc.path);
          // reason: never written back: no check-then-write is atomic across processes, so any rollback could overwrite
          // an edit saved after its check; the file keeps status: done uncommitted and the message says what to do (BR-2229, issue #82).
          return early("environment", `the close commit could not be made: ${c.error.message}\n${closeLeftNote(doc.path)}`);
        }
        close = { subject, path: doc.path };
      }
    }

    // Same-file overlap with other changes in flight: a notice only, never a refusal (BR-2062).
    noticeOverlaps(ws, wt, subject, "land", say);
    const entered = enter(ws.db, wt, subject, ws.actor, lander);
    entry = entered.id;
    if (entered.kept) say(`back in the landing queue at the place it kept after ${KEPT_AFTER[entered.kept.after]} (queue entry ${entry}, ${Math.round(entered.kept.resolveMs / 1000)}s after it stopped)`);
    // The claim names this lander until the landing ends, so the session exiting meanwhile frees it to no one (BR-2142, issue #17).
    bound = lander ? bindToLander(ws.db, wt, ws.actor, lander) : undefined;
    out = await queueAndLand(ws, opts, say, { entry, subject, branch: branch.value, running });
    // After the turn has ended, so a slow remote holds up no other landing; a failed push leaves this landing landed (BR-2259, BR-2260).
    if (out.kind === "landed") pushMain(ws, say);
    return out;
  } finally {
    if (close && out?.kind !== "landed") reopen(wt, close, say);
    if (bound) unbindFromLander(ws.db, bound);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/**
 * A lander signalled while its leader has it locked in a batch (BR-2172) waits here until the batch is settled: main
 * moved with it (landed, its close commit stays) or did not (it is waiting again, so the handler gives the entry up
 * and takes the close commit back itself). Neither it nor the leader decides alone at one instant, so a member still
 * alive when the leader looks is never skipped by both (BR-2099, BR-2018, issue #43). Blocking on purpose: nothing else
 * of this landing runs meanwhile. Always true, so it reads as a step of the handler's condition.
 */
function waitWhileLocked(ws: Workspace, entry: number, say: Say): true {
  let said = false;
  // reason: bounded by the leader: settleLocked frees this entry once the leader stops landing, dies or stops beating (BR-2173).
  while (settleLocked(ws.db, entry, ws.config.landerStaleMs) === "locked") {
    if (!said) say("signal received while this landing is locked in a batch whose leader is moving main; waiting for the batch to settle");
    said = true;
    Bun.sleepSync(50);
  }
  return true;
}

async function queueAndLand(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running }): Promise<LandOutcome> {
  const wt = ws.root;
  // The claim stays renewed for as long as this landing waits and runs, so it cannot expire under it (BR-2108).
  const keep = setInterval(() => keepClaim(ws.db, wt, ws.actor, ws.config.claimLeaseMs), Math.min(60_000, Math.max(50, ws.config.claimLeaseMs / 3)));
  try {
    return await waitAndLand(ws, opts, say, t);
  } finally {
    clearInterval(keep);
  }
}

async function waitAndLand(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running }): Promise<LandOutcome> {
  const wt = ws.root;
  const main = ws.config.main;
  const { entry, subject } = t;
  let deadline = Date.now() + opts.timeoutMs;
  const queued = Date.now();
  let lastAhead = -1;
  let lastMain = "";
  // When this entry started being tested in another lander's batch; that time does not count toward the timeout (BR-2048).
  let batchedSince: number | undefined;
  const poll = waitPollMs(ws.config.landerStaleMs);
  for (;;) {
    const turn = tryTurn(ws.db, entry, ws.config.landerStaleMs, priorityNow(ws));
    if (!turn.batched && batchedSince !== undefined) {
      // reason: the deadline moves later by the time spent in the batch, so a member that comes back keeps the wait it had left (BR-2048, issue #75).
      deadline += Date.now() - batchedSince;
      batchedSince = undefined;
    }
    // A later lander skipped this entry while it was silent; it may already have moved main (BR-2144, issue #29).
    if (turn.lost !== undefined) return lostTurn(ws, subject, wt, turn.lost, "queue");
    // The lander ahead tested this change in its batch and landed it (BR-2172).
    if (turn.landedBy) return landedInBatch(ws, opts, say, { entry, subject }, turn.landedBy);
    // The lander ahead found that the floor fails once this change joins its batch (BR-2173).
    if (turn.refusedBy) {
      ws.db.event(ws.actor, "land.refuse", subject, { reason: turn.refusedBy.reason, message: turn.refusedBy.message.slice(0, 2000), batched_by: turn.refusedBy.leader, diff: ownDiffId(wt, main) });
      return { kind: "refused", reason: turn.refusedBy.reason, message: turn.refusedBy.message };
    }
    // While another lander tests this change in its batch, it neither refuses nor times out: the batch settles it (BR-2172).
    if (turn.batched) {
      batchedSince ??= Date.now();
      if (lastAhead !== -2) say(`being tested in the batch of queue entry ${turn.batched.leader}; keep this worktree as it is`);
      lastAhead = -2;
      await Bun.sleep(poll);
      continue;
    }
    if (turn.mine) {
      // How long this lander waited in the queue, separate from how long its floor takes (BR-2122).
      ws.db.event(ws.actor, "land.turn", subject, { entry, waited_ms: Date.now() - queued });
      break;
    }
    if (turn.ahead !== lastAhead) say(`waiting: ${turn.ahead} landing(s) ahead`);
    lastAhead = turn.ahead;
    // Each time main moves while this lander waits, a merge of main and HEAD in memory predicts the rebase:
    // a conflict refuses now instead of when the turn comes, and the worktree is not touched (BR-2153, D-22).
    const tip = git(wt, "rev-parse", main);
    if (tip.ok && tip.value !== lastMain) {
      lastMain = tip.value;
      const predicted = predictedConflicts(wt, tip.value);
      if (!predicted.ok) say(`conflict check while waiting did not run (${predicted.error}); a conflict shows at the turn`);
      const files = predicted.ok ? predicted.files : [];
      if (files.length > 0) {
        const found = `while waiting to land: a merge with ${main} ${tip.value.slice(0, 9)} conflicts in: ${files.join(", ")}\nResolve with \`git rebase ${main}\` in ${wt}, then land again.`;
        const until = failKeepingPlace(ws.db, entry, `conflict: ${found.slice(0, 500)}`, ws.config.landKeepPlaceMs);
        const message = found + keptNote(until);
        ws.db.event(ws.actor, "land.refuse", subject, { reason: "conflict", message: message.slice(0, 2000), early: true, diff: ownDiffId(wt, main), ...(until ? { keeps_place_until: until } : {}) });
        return { kind: "refused", reason: "conflict", message };
      }
    }
    if (Date.now() > deadline) {
      // reason: a landing that gave up waiting keeps its place for its own next landing, like a conflict (BR-2368, D-75).
      const until = failKeepingPlace(ws.db, entry, "timeout", ws.config.landKeepPlaceMs);
      ws.db.event(ws.actor, "land.refuse", subject, { reason: "timeout", ahead: turn.ahead, diff: ownDiffId(wt, main), ...(until ? { keeps_place_until: until } : {}) });
      return { kind: "timeout", ahead: turn.ahead, ...(until ? { keepsPlaceUntil: until } : {}) };
    }
    await Bun.sleep(poll);
  }

  // The heartbeat runs from the moment this lander has its turn until the landing ends, through the floor,
  // the review and before_land, so a slow step never makes a later lander think this one died (BR-2049).
  const beat = setInterval(() => heartbeat(ws.db, entry), Math.min(30_000, Math.max(50, ws.config.landerStaleMs / 3)));
  try {
    return await landTurn(ws, opts, say, t);
  } finally {
    clearInterval(beat);
  }
}

async function landTurn(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running }): Promise<LandOutcome> {
  const wt = ws.root;
  const main = ws.config.main;
  const { entry, subject } = t;
  let floorSkipped = false;
  let floorDeferred = false;
  const refuse = (reason: Extract<LandOutcome, { kind: "refused" }>["reason"], found: string, findings?: readonly Finding[]): LandOutcome => {
    // A conflict keeps this entry's place for its own next landing; every other refusal sends that one to the tail (BR-2177).
    const until = reason === "conflict" ? failKeepingPlace(ws.db, entry, `${reason}: ${found.slice(0, 500)}`, ws.config.landKeepPlaceMs) : null;
    if (reason !== "conflict") finishEntry(ws.db, entry, "failed", `${reason}: ${found.slice(0, 500)}`);
    const message = found + keptNote(until);
    ws.db.event(ws.actor, "land.refuse", subject, { reason, message: message.slice(0, 2000), diff: ownDiffId(wt, main), ...(findings ? findingDetail(findings) : {}), ...(floorSkipped ? { floor_skipped: true } : {}), ...(floorDeferred ? { floor_deferred: true } : {}), ...(until ? { keeps_place_until: until } : {}) });
    return { kind: "refused", reason, message, ...(findings ? { findings } : {}) };
  };

  // Edits made while waiting in the queue would make the rebase fail; name them as uncommitted, not as a conflict (BR-2105).
  const waited = changesIn(wt);
  if (waited.length > 0) return refuse("dirty", `the worktree got uncommitted changes while waiting to land; commit them and land again:\n${waited.map((l) => `  ${l}`).join("\n")}`);

  const base = git(wt, "rev-parse", main);
  // reason: git failing is an environment error, not a check's verdict, so it pollutes no check in `canon stats` (BR-2193).
  if (!base.ok) return refuse("environment", base.error.message);
  // The branch as it was before the rebase: what the close commit's pass records were computed on (BR-2244).
  const before = git(wt, "rev-parse", "HEAD");
  if (!before.ok) return refuse("environment", before.error.message);
  say(`rebase onto ${main} ${base.value.slice(0, 9)}`);
  const reb = git(wt, "rebase", "-q", base.value);
  if (!reb.ok) {
    // reason: a signal that killed the rebase is handled on the next tick (BR-2099); let it run before calling this a conflict.
    await Bun.sleep(0);
    const files = git(wt, "diff", "--name-only", "--diff-filter=U");
    if (rebaseInProgress(wt)) git(wt, "rebase", "--abort");
    // reason: a rebase that fails with no conflicted file did not conflict (a lock, a hook); it keeps no place (BR-2193, BR-2177).
    if (!files.ok || files.value === "") return refuse("environment", `rebase onto ${main} failed without a conflict: ${reb.error.message}`);
    return refuse("conflict", `rebase onto ${main} conflicts in: ${files.ok ? files.value.split("\n").join(", ") : "?"}\nResolve with \`git rebase ${main}\` in ${wt}, then land again.`);
  }
  // The commit the floor, canon check, the review and before_land prove; only this commit may become main (BR-2106).
  const tested = git(wt, "rev-parse", "HEAD");
  if (!tested.ok) return refuse("environment", tested.error.message);

  // With floor_timing after, the floor runs on main in the background once main has moved, so this landing runs
  // only its own steps and joins no batch; the landing tree decides, as it decides the floor command (BR-2218, D-31).
  floorDeferred = timingOf(wt) === "after";
  if (floorDeferred) {
    const readable = pathCanonReads(wt);
    if (!readable.ok) return refuse("config", readable.error.message);
  }

  // Landings waiting right behind this one are tested with it under one floor run (BR-2172, D-26); only a member that
  // is refused or changes leaves the batch, and a failing floor is traced to the change that makes it fail (BR-2173, D-42).
  if (ws.config.landBatchMax > 1 && !floorDeferred) {
    const batched = await landBatch(ws, opts, say, { ...t, base: base.value, head: tested.value, before: before.value });
    if (batched?.kind === "landed") return finishLanding(ws, opts, say, { entry, subject, sha: tested.value });
    if (batched?.kind === "lost") return batched.outcome;
    if (batched) return refuse(batched.reason, batched.message, batched.findings);
  }

  // A landing that changes only paths the project declares no test reads has main's already-tested code tree,
  // so the floor would prove nothing new (BR-2164). Decided first so a refusal below records floor_skipped.
  const skip = floorDeferred ? undefined : floorSkip(wt, base.value, tested.value, say);
  if (skip) floorSkipped = true;

  // reason: this landing's own steps run before the floor, as each member's do in a batch, so a refusal from canon check
  // or a review never wastes a floor run (BR-2014, BR-2248, D-26, D-42, #134); the test report canon check reads is
  // written by `canon work test`, not by this floor (D-64).
  const head = tested;
  const steps = await verifyChange(ws, opts, say, { wt, base: base.value, main: base.value, head: head.value, before: before.value, subject, branch: t.branch, running: t.running, worktree: wt });
  if (!steps.ok) return refuse(steps.reason, steps.message, steps.findings);

  if (floorDeferred) {
    say("floor: deferred — floor_timing is after; main is tested in the background once it moves (canon floor watch)");
  } else if (skip) {
    say(`floor: skipped — all ${skip.paths.length} changed path(s) are under floor_skip_paths (${skip.under.join(", ")})`);
    ws.db.event(ws.actor, "floor.skip", subject, { entry, paths: skip.paths.slice(0, 50), under: skip.under });
  } else {
    const floor = await runFloor(ws, say, wt, `land-${entry}.log`, t.running);
    if (floor.code !== 0) return refuse("floor", `floor exited ${floor.code} (full log: ${floor.log})\n${floor.tail}`);
  }
  const now = git(wt, "rev-parse", "HEAD");
  const edits = changesIn(wt);
  if (!now.ok || now.value !== head.value || edits.length > 0) {
    const lines: string[] = [];
    if (!now.ok || now.value !== head.value) {
      const log = now.ok ? git(wt, "log", "--format=%h %s", `${head.value}..${now.value}`) : now;
      lines.push(`HEAD moved from ${head.value.slice(0, 9)} to ${now.ok ? now.value.slice(0, 9) : "?"}${log.ok && log.value !== "" ? `:\n${log.value.split("\n").map((l) => `    ${l}`).join("\n")}` : ""}`);
    }
    for (const e of edits) lines.push(`uncommitted: ${e}`);
    return refuse("moved-during-land", `the worktree changed after the rebase, so what was tested is not what would land; land again:\n${lines.map((l) => `  ${l}`).join("\n")}`);
  }
  // A lander that was silent past the stale time during its turn may have been skipped meanwhile; it no longer
  // holds the turn and must not move main next to the one that took it over (BR-2144).
  const turn = holdsTurn(ws.db, entry);
  if (!turn.held) return lostTurn(ws, subject, wt, turn.state, "before-main");
  const fingerprint = ownDiffId(wt, main); // before main moves: afterwards the merge base is HEAD itself
  const moved = moveMain(ws, base.value, head.value);
  if (moved !== "moved") return refuse(moved.reason, moved.message);

  finishEntry(ws.db, entry, "landed", head.value);
  ws.db.event(ws.actor, "land.ok", subject, { sha: head.value, base: base.value, branch: t.branch, diff: fingerprint, ...(steps.reviewNotes ?? {}), ...(floorSkipped ? { floor_skipped: true } : {}), ...(floorDeferred ? { floor_deferred: true } : {}) });
  say(`landed ${head.value.slice(0, 9)} on ${main}`);
  // The background floor starts on the main this landing made, before after_land (BR-2218, BR-2219).
  if (floorDeferred) ensureWatcher(ws, say);
  afterLand(ws, say, { entry, subject, base: base.value, head: head.value, branch: t.branch });
  return finishLanding(ws, opts, say, { entry, subject, sha: head.value });
}
