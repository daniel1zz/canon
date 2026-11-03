import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../workspace.ts";
import { readConfig, type Config } from "../../config/config.ts";
import { check, type Finding } from "../../knowledge/check/check.ts";
import { httpFetch, OPTIONS_SECTION, sources, verify, type Fetcher } from "../../knowledge/check/sources.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import { bindToLander, keepClaim, releaseOwnClaim, renewClaim, unbindFromLander } from "../claims/claims.ts";
import { dropHandoff } from "../session/handoffs.ts";
import { batchCandidates, enter, failForConflict, failIfActive, finishEntry, heartbeat, holdsTurn, isSolo, joinBatch, landBatched, leaveBatch, lockBatch, tryTurn, unlockBatch } from "./queue.ts";
import { isGone, selfProcess, sessionProcess } from "../claims/liveness.ts";
import { logFile, runHooks, runHooksInBackground } from "../../config/hooks.ts";
import { noticeOverlaps } from "../session/overlap.ts";
import { type Doc } from "../../knowledge/documents/model.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { setMeta } from "../../knowledge/documents/write.ts";
import { hasLessons, LESSONS_SECTION } from "../../knowledge/documents/templates.ts";
import { git, gitEnv, isClean, listWorktrees } from "../../kernel/git.ts";
import { duplicatePrompt, reviewPrompt, runReview, SKILL_FILE, standingText, type DeletedDoc } from "../../knowledge/review/review.ts";

/**
 * Landing (design §6): queue → rebase onto main → floor → canon check → sources → review → before_land →
 * compare-and-swap main. The only refusals are outcome guards (P4).
 */

export interface LandOptions {
  /** Close the change (status done) and remove its worktree after landing. */
  readonly finish: boolean;
  /** Give up waiting for the queue after this long. */
  readonly timeoutMs: number;
  /** How decision sources given as URLs are fetched (BR-2111); the network unless a test supplies one. */
  readonly fetcher?: Fetcher;
  /** The workflow guide `canon brief` prints, one of the standing texts the duplicate review compares (BR-2143). */
  readonly guide?: string;
}

export type LandOutcome =
  | { readonly kind: "landed"; readonly sha: string; readonly change: string | null; readonly finished: boolean }
  | { readonly kind: "refused"; readonly reason: "claimed" | "dirty" | "conflict" | "floor" | "check" | "source" | "review" | "hook" | "moved-during-land" | "main-moved" | "main-dirty" | "lost-turn" | "no-floor" | "no-claim" | "lessons" | "on-main"; readonly message: string; readonly findings?: readonly Finding[] }
  | { readonly kind: "timeout"; readonly ahead: number };

/**
 * Lands the current worktree's branch on main: queue → rebase onto main → floor → canon check →
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

  // The close commit lands with the work, so the tree that is tested is the tree that becomes main (BR-2106);
  // a landing that does not reach main takes it back out, so the change never says done without landing (BR-2018).
  let close: CloseCommit | undefined;
  if (opts.finish) {
    if (!subject) return early("no-claim", "--finish needs a claimed change; this worktree holds none");
    const corpus = readCorpus(wt, ws.config.types, ws.config).corpus;
    const doc = findDoc(corpus, subject);
    if (doc?.kind === "change" && doc.status === "open") {
      // reason: lessons are known when the work ends, so closing is where they are required; old closed changes stay valid (BR-2161, D-24)
      if (!hasLessons(doc.body)) return early("lessons", `${subject} has no filled ${LESSONS_SECTION} section: write each lesson this work found and where it went (a mechanism's id, 只靠文字：<原因>, or 待负责人确认是否固化), or 无 when there is none; commit, then land --finish again`);
      const s = setMeta(wt, doc, { status: "done" });
      if (!s.ok) return early("check", s.error.message);
      git(wt, "add", doc.path);
      const c = git(wt, "commit", "-q", "-m", closeSubject(subject));
      if (!c.ok) return early("check", c.error.message);
      close = { subject, path: doc.path };
    }
  }

  // Same-file overlap with other changes in flight: a notice only, never a refusal (BR-2062).
  noticeOverlaps(ws, wt, subject, "land", say);
  const lander = selfProcess();
  const entered = enter(ws.db, wt, subject, ws.actor, lander);
  const entry = entered.id;
  if (entered.kept) say(`back in the landing queue at the place it kept after its conflict (queue entry ${entry}, resolved in ${Math.round(entered.kept.resolveMs / 1000)}s)`);
  // The claim names this lander until the landing ends, so the session exiting meanwhile frees it to no one (BR-2142, issue #17).
  const bound = lander ? bindToLander(ws.db, wt, ws.actor, lander) : undefined;
  const running: Running = {};
  // A lander killed by a signal (a tool timeout, Ctrl-C) gives its turn up at once and leaves no rebase half done (BR-2099).
  const onSignal = (signal: NodeJS.Signals) => {
    running.floor?.kill();
    // reason: process.exit skips the batch's finally, so its temporary worktree is removed here (BR-2099, BR-2172).
    if (existsSync(batchDir(ws, entry))) git(ws.primary, "worktree", "remove", "--force", batchDir(ws, entry));
    const aborted = rebaseInProgress(wt) && git(wt, "rebase", "--abort").ok;
    // A signal after main moved leaves the landed entry as it is: the landing happened.
    // reason: an interruption, not a check's verdict, so it is its own event kind and no check in `canon stats` (BR-2067).
    // reason: only while this lander still owns the entry; a later landing may have taken it back as its kept place (BR-2177, issue #45).
    if (failIfActive(ws.db, entry, "killed", lander ?? null)) {
      ws.db.event(ws.actor, "land.killed", subject, { signal, rebaseAborted: aborted });
      if (close) reopen(wt, close, say);
    }
    if (bound) unbindFromLander(ws.db, bound);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let out: LandOutcome | undefined;
  try {
    out = await queueAndLand(ws, opts, say, { entry, subject, branch: branch.value, running });
    return out;
  } finally {
    if (close && out?.kind !== "landed") reopen(wt, close, say);
    if (bound) unbindFromLander(ws.db, bound);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** The `canon: close C-n` commit `--finish` made before queuing, so a landing that fails can take it back. */
export interface CloseCommit {
  readonly subject: string;
  readonly path: string;
}

const closeSubject = (change: string) => `canon: close ${change}`;

/**
 * Takes the close commit back out after a landing that did not reach main: only while HEAD is still `top`, the
 * close commit that was checked, and it changes nothing but the change file. The branch moves by a compare-and-swap
 * on HEAD, so a commit made in the worktree meanwhile is never dropped; `git read-tree -m -u` then updates the
 * change file and refuses over local edits to it, in which case the branch is swapped back (BR-2018, issue #34).
 */
export function reopen(wt: string, close: CloseCommit, say: Say, top = git(wt, "rev-parse", "HEAD")): boolean {
  const notReopened = (why: string) => {
    say(`${close.subject} was not reopened (${why}); it says done although it did not land`);
    return false;
  };
  if (!top.ok) return notReopened(top.error.message);
  const sha = top.value;
  const parent = git(wt, "rev-parse", `${sha}~1`);
  const subject = git(wt, "log", "-1", "--format=%s", sha);
  const files = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", `${sha}~1`, sha);
  if (!parent.ok || !subject.ok || subject.value !== closeSubject(close.subject) || !files.ok || files.value !== close.path) {
    return notReopened("its close commit is no longer the top commit");
  }
  // reason: compare-and-swap, so a commit made after the check above stays on the branch (issue #34).
  const cas = git(wt, "update-ref", "-m", `canon: reopen ${close.subject}`, "HEAD", parent.value, sha);
  if (!cas.ok) return notReopened("HEAD moved after the check");
  const sync = git(wt, "read-tree", "-m", "-u", sha, parent.value);
  if (!sync.ok) {
    git(wt, "update-ref", "-m", `canon: keep ${close.subject} closed`, "HEAD", sha, parent.value);
    return notReopened(sync.error.message.split("\n")[0] ?? "read-tree failed");
  }
  say(`${close.subject} reopened: the landing did not reach main, so its close commit was taken back`);
  return true;
}

/** What a signal handler must stop: the floor while it runs. */
interface Running {
  floor?: { kill(): void } | undefined;
}

/** `git status --porcelain` lines of the worktree: uncommitted and untracked changes. */
function changesIn(wt: string): string[] {
  const st = git(wt, "status", "--porcelain");
  if (!st.ok) return [`? (${st.error.message})`];
  return st.value === "" ? [] : st.value.split("\n");
}

function rebaseInProgress(wt: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((d) => {
    const p = git(wt, "rev-parse", "--path-format=absolute", "--git-path", d);
    return p.ok && existsSync(p.value);
  });
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

/** How often a waiting lander tries for its turn. */
const POLL_MS = 2000;

async function waitAndLand(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running }): Promise<LandOutcome> {
  const wt = ws.root;
  const main = ws.config.main;
  const { entry, subject } = t;
  const deadline = Date.now() + opts.timeoutMs;
  const queued = Date.now();
  let lastAhead = -1;
  let lastMain = "";
  for (;;) {
    const turn = tryTurn(ws.db, entry, ws.config.landerStaleMs);
    // A later lander skipped this entry while it was silent; it may already have moved main (BR-2144, issue #29).
    if (turn.lost !== undefined) return lostTurn(ws, subject, wt, turn.lost, "queue");
    // The lander ahead tested this change in its batch and landed it (BR-2172).
    if (turn.landedBy) return landedInBatch(ws, opts, say, { entry, subject }, turn.landedBy);
    // While another lander tests this change in its batch, it neither refuses nor times out: the batch settles it (BR-2172).
    if (turn.batched) {
      if (lastAhead !== -2) say(`being tested in the batch of queue entry ${turn.batched.leader}; keep this worktree as it is`);
      lastAhead = -2;
      await Bun.sleep(POLL_MS);
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
        const until = failForConflict(ws.db, entry, `conflict: ${found.slice(0, 500)}`, ws.config.landKeepPlaceMs);
        const message = found + keptNote(until);
        ws.db.event(ws.actor, "land.refuse", subject, { reason: "conflict", message: message.slice(0, 2000), early: true, diff: ownDiffId(wt, main), ...(until ? { keeps_place_until: until } : {}) });
        return { kind: "refused", reason: "conflict", message };
      }
    }
    if (Date.now() > deadline) {
      finishEntry(ws.db, entry, "failed", "timeout");
      ws.db.event(ws.actor, "land.refuse", subject, { reason: "timeout", ahead: turn.ahead, diff: ownDiffId(wt, main) });
      return { kind: "timeout", ahead: turn.ahead };
    }
    await Bun.sleep(POLL_MS);
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

/** What a conflict refusal tells the lander about the place it keeps in the queue (BR-2177). */
function keptNote(until: string | null): string {
  if (!until) return "";
  return `\nThis landing keeps its place in the queue until ${until}: landing again from this worktree before then puts it back ahead of the landings queued after it; they go on landing while you resolve.`;
}

/**
 * The refusal of an entry that another lander marked abandoned: nothing moves, and the entry keeps the state
 * that lander gave it (BR-2144). `stage` says whether it was found while waiting or just before main would move.
 */
function lostTurn(ws: Workspace, subject: string | null, wt: string, state: string, stage: "queue" | "before-main"): LandOutcome {
  const message = `this landing's queue entry is no longer active (${state}): another lander skipped it after it stopped heart-beating, so ${ws.config.main} was not moved; land again`;
  // reason: the lander was interrupted, not judged by a check, so it is its own event kind and no check in `canon stats` (BR-2144, like land.killed in BR-2099).
  ws.db.event(ws.actor, "land.lost", subject, { stage, state, diff: ownDiffId(wt, ws.config.main) });
  return { kind: "refused", reason: "lost-turn", message };
}

/**
 * Files a merge of `base` and HEAD would leave conflicted, from `git merge-tree --write-tree` (git 2.38+), which
 * merges in memory and touches neither the index nor the worktree (D-22). Not ok when the prediction cannot run
 * (an older git, a bad ref): then the real rebase at the turn decides, as before (BR-2015).
 */
export function predictedConflicts(wt: string, base: string): { ok: true; files: string[] } | { ok: false; error: string } {
  const r = Bun.spawnSync(["git", "-c", "core.quotePath=false", "merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD"], { cwd: wt, stdout: "pipe", stderr: "pipe" });
  const lines = r.stdout.toString().trim().split("\n");
  // reason: exit 1 is a conflict only when the merged tree's id came first; a bad ref also exits 1, with no tree (BR-2153).
  const merged = /^[0-9a-f]{40,64}$/.test(lines[0] ?? "");
  if (r.exitCode === 0 && merged) return { ok: true, files: [] };
  if (r.exitCode !== 1 || !merged) return { ok: false, error: `git merge-tree exited ${r.exitCode}: ${r.stderr.toString().trim().split("\n")[0] ?? ""}` };
  return { ok: true, files: [...new Set(lines.slice(1).filter((l) => l !== ""))].sort() };
}

/** Per-kind counts and the files involved, so `canon stats` can tell which checks are precise (BR-2094, P6). */
export function findingDetail(findings: readonly Finding[]): { findings: Record<string, number>; paths: string[] } {
  const kinds: Record<string, number> = {};
  for (const f of findings) kinds[f.rule] = (kinds[f.rule] ?? 0) + 1;
  return { findings: kinds, paths: [...new Set(findings.map((f) => f.path))].sort().slice(0, 50) };
}

async function landTurn(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running }): Promise<LandOutcome> {
  const wt = ws.root;
  const main = ws.config.main;
  const { entry, subject } = t;
  let floorSkipped = false;
  const refuse = (reason: Extract<LandOutcome, { kind: "refused" }>["reason"], found: string, findings?: readonly Finding[]): LandOutcome => {
    // A conflict keeps this entry's place for its own next landing; every other refusal sends that one to the tail (BR-2177).
    const until = reason === "conflict" ? failForConflict(ws.db, entry, `${reason}: ${found.slice(0, 500)}`, ws.config.landKeepPlaceMs) : null;
    if (reason !== "conflict") finishEntry(ws.db, entry, "failed", `${reason}: ${found.slice(0, 500)}`);
    const message = found + keptNote(until);
    ws.db.event(ws.actor, "land.refuse", subject, { reason, message: message.slice(0, 2000), diff: ownDiffId(wt, main), ...(findings ? findingDetail(findings) : {}), ...(floorSkipped ? { floor_skipped: true } : {}), ...(until ? { keeps_place_until: until } : {}) });
    return { kind: "refused", reason, message, ...(findings ? { findings } : {}) };
  };

  // Edits made while waiting in the queue would make the rebase fail; name them as uncommitted, not as a conflict (BR-2105).
  const waited = changesIn(wt);
  if (waited.length > 0) return refuse("dirty", `the worktree got uncommitted changes while waiting to land; commit them and land again:\n${waited.map((l) => `  ${l}`).join("\n")}`);

  const base = git(wt, "rev-parse", main);
  if (!base.ok) return refuse("main-moved", base.error.message);
  say(`rebase onto ${main} ${base.value.slice(0, 9)}`);
  const reb = git(wt, "rebase", "-q", base.value);
  if (!reb.ok) {
    // reason: a signal that killed the rebase is handled on the next tick (BR-2099); let it run before calling this a conflict.
    await Bun.sleep(0);
    const files = git(wt, "diff", "--name-only", "--diff-filter=U");
    git(wt, "rebase", "--abort");
    return refuse("conflict", `rebase onto ${main} conflicts in: ${files.ok ? files.value.split("\n").join(", ") : "?"}\nResolve with \`git rebase ${main}\` in ${wt}, then land again.`);
  }
  // The commit the floor, canon check, the review and before_land prove; only this commit may become main (BR-2106).
  const tested = git(wt, "rev-parse", "HEAD");
  if (!tested.ok) return refuse("main-moved", tested.error.message);

  // Landings waiting right behind this one are tested with it under one floor run (BR-2172, D-26); a batch that
  // does not land as a whole sends them back to land on their own, and this landing goes on alone (BR-2173).
  if (ws.config.landBatchMax > 1 && !isSolo(ws.db, entry)) {
    const batched = await landBatch(ws, opts, say, { ...t, base: base.value, head: tested.value });
    if (batched?.kind === "landed") return finishLanding(ws, opts, say, { entry, subject, sha: tested.value });
    if (batched?.kind === "lost") return batched.outcome;
    if (batched) return refuse(batched.reason, batched.message);
  }

  // A landing that changes only paths the project declares no test reads has main's already-tested code tree,
  // so the floor would prove nothing new (BR-2164).
  const skip = floorSkip(wt, base.value, tested.value);
  if (skip) {
    floorSkipped = true;
    say(`floor: skipped — all ${skip.paths.length} changed path(s) are under floor_skip_paths (${skip.under.join(", ")})`);
    ws.db.event(ws.actor, "floor.skip", subject, { entry, paths: skip.paths.slice(0, 50), under: skip.under });
  } else {
    const floor = await runFloor(ws, say, wt, `land-${entry}.log`, t.running);
    if (floor.code !== 0) return refuse("floor", `floor exited ${floor.code} (full log: ${floor.log})\n${floor.tail}`);
  }

  const head = tested;
  const steps = await verifyChange(ws, opts, say, { wt, base: base.value, head: head.value, subject, branch: t.branch });
  if (!steps.ok) return refuse(steps.reason, steps.message, steps.findings);
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
  ws.db.event(ws.actor, "land.ok", subject, { sha: head.value, branch: t.branch, diff: fingerprint, ...(steps.reviewNotes ?? {}), ...(floorSkipped ? { floor_skipped: true } : {}) });
  say(`landed ${head.value.slice(0, 9)} on ${main}`);
  afterLand(ws, say, { entry, subject, base: base.value, head: head.value, branch: t.branch });
  return finishLanding(ws, opts, say, { entry, subject, sha: head.value });
}

/** Starts after_land in the background for one landed change, with its own base and head (BR-2030). */
function afterLand(ws: Workspace, say: Say, l: { entry: number; subject: string | null; base: string; head: string; branch: string }): void {
  if (ws.config.hooks.after_land.length === 0) return;
  const env = { CANON_BASE: l.base, CANON_HEAD: l.head, CANON_BRANCH: l.branch };
  const log = runHooksInBackground({ db: ws.db, actor: ws.actor, event: "after_land", change: l.subject, cwd: ws.primary, env }, ws.config.hooks.after_land, logFile(ws.db, `after-land-${l.entry}.log`), l.entry);
  say(`after_land${l.subject ? ` for ${l.subject}` : ""} running in the background (log: ${log})`);
}

/** After main holds this change: with --finish, releases the own claim and handoff (BR-2018, BR-2108). */
function finishLanding(ws: Workspace, opts: LandOptions, say: Say, l: { entry: number; subject: string | null; sha: string }): LandOutcome {
  let finished = false;
  if (opts.finish && l.subject) {
    // Another session that took the change over meanwhile keeps its claim and its handoff (BR-2108).
    if (releaseOwnClaim(ws.db, l.subject, ws.root, ws.actor)) dropHandoff(ws.db, l.subject);
    else say(`${l.subject} is claimed by another session now; its claim and handoff were left as they are`);
    finished = true;
    say(`${l.subject} closed; remove the worktree with \`canon work clean ${l.subject}\` once you have left it`);
  }
  return { kind: "landed", sha: l.sha, change: l.subject, finished };
}

/** Runs the floor in `cwd`, its whole output in the log `name`; `running` lets a signal stop it (BR-2014, BR-2099). */
async function runFloor(ws: Workspace, say: Say, cwd: string, name: string, running: Running): Promise<{ code: number; log: string; tail: string }> {
  say(`floor: ${ws.config.floor}`);
  const log = join(dirname(ws.db.db.filename), "logs", name);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const proc = Bun.spawn(["sh", "-c", ws.config.floor!], { cwd, stdout: fd, stderr: fd });
  running.floor = proc;
  const code = await proc.exited;
  running.floor = undefined;
  closeSync(fd);
  return { code, log, tail: code === 0 ? "" : readFileSync(log, "utf8").split("\n").slice(-40).join("\n") };
}

/** The temporary worktree a batch led by queue entry `entry` is tested in. */
const batchDir = (ws: Workspace, entry: number) => join(dirname(ws.db.db.filename), "batch", String(entry));

/** One change in a batch: its queue entry, and the chain commit below it (`base`) and its own top commit (`head`). */
interface Link {
  readonly entry: number;
  readonly subject: string | null;
  readonly worktree: string;
  readonly branch: string;
  /** The member's HEAD when it joined; its worktree must still be there when main moves (BR-2106). */
  readonly joined: string;
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
async function landBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null; branch: string; running: Running; base: string; head: string }): Promise<{ kind: "landed" } | { kind: "refused"; reason: "main-moved" | "main-dirty"; message: string } | { kind: "lost"; outcome: LandOutcome } | undefined> {
  const main = ws.config.main;
  const members: { id: number; subject: string | null; worktree: string; branch: string; joined: string }[] = [];
  for (const c of batchCandidates(ws.db, t.entry, ws.config.landBatchMax - 1, ws.config.landerStaleMs)) {
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
  git(ws.primary, "worktree", "prune");
  const added = git(ws.primary, "worktree", "add", "-q", "--detach", dir, t.head);
  if (!added.ok) {
    leave(0, false);
    say(`batch: could not create a worktree to test in (${added.error.message.split("\n")[0]}); landing alone`);
    return undefined;
  }
  try {
    const links: Link[] = [{ entry: t.entry, subject: t.subject, worktree: ws.root, branch: t.branch, joined: t.head, base: t.base, head: t.head }];
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
      links.push({ entry: m.id, subject: m.subject, worktree: m.worktree, branch: m.branch, joined: m.joined, base: prev, head: top.value });
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
      const setup = Bun.spawnSync(["sh", "-c", ws.config.setup], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (setup.exitCode !== 0) return fallBack(`setup exited ${setup.exitCode} in the batch worktree`);
    }
    const notes: Record<number, Awaited<ReturnType<typeof verifyChange>>> = {};
    for (const l of links) {
      const co = git(dir, "checkout", "-q", "--detach", l.head);
      if (!co.ok) return fallBack(`checkout of ${l.head.slice(0, 9)} failed: ${co.error.message}`);
      const steps = await verifyChange(ws, opts, say, { wt: dir, base: l.base, head: l.head, subject: l.subject, branch: l.branch });
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
      ws.db.event(ws.actor, "land.ok", l.subject, { sha: l.head, branch: l.branch, diff: fingerprints.get(l.entry) ?? null, ...(reviewNotes ?? {}), ...(skip ? { floor_skipped: true } : {}), ...(l.entry !== t.entry ? { batched_by: t.entry } : { batch: links.slice(1).map((x) => x.entry) }) });
      say(`landed ${l.head.slice(0, 9)} (${l.subject ?? `entry ${l.entry}`}) on ${main}`);
    }
    for (const l of links) afterLand(ws, say, { entry: l.entry, subject: l.subject, base: l.base, head: l.head, branch: l.branch });
    return { kind: "landed" };
  } finally {
    git(ws.primary, "worktree", "remove", "--force", dir);
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
function landedInBatch(ws: Workspace, opts: LandOptions, say: Say, t: { entry: number; subject: string | null }, by: { leader: number; sha: string; head: string }): LandOutcome {
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

/** Why one change's own landing steps refused it: the refusal reason, message and canon check findings. */
interface StepFailure {
  readonly ok: false;
  readonly reason: Extract<LandOutcome, { kind: "refused" }>["reason"];
  readonly message: string;
  readonly findings?: readonly Finding[];
}
type Steps = { readonly ok: true; readonly reviewNotes: { reviewed: string[]; notes: readonly string[] } | undefined } | StepFailure;

/**
 * One change's own landing steps after the floor, on the checkout `wt` at `head` (main or the batch chain at
 * `base` below it): canon check, decision sources, the rule and duplicate reviews, before_land (BR-2016,
 * BR-2009, BR-2111, BR-2143, BR-2057). A solo landing runs them in its worktree; a batch, per change (BR-2172).
 */
async function verifyChange(ws: Workspace, opts: LandOptions, say: Say, v: { wt: string; base: string; head: string; subject: string | null; branch: string }): Promise<Steps> {
  const { wt, subject } = v;
  const base = { value: v.base };
  const head = { value: v.head };
  const refuse = (reason: StepFailure["reason"], message: string, findings?: readonly Finding[]): StepFailure => ({ ok: false, reason, message, ...(findings ? { findings } : {}) });
  const read = readCorpus(wt, ws.config.types, ws.config);
  const tests = testFilesFor(wt, ws.config);
  const findings = check({ root: wt, ...read, testFiles: tests });
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);


  // Every added, edited or deleted file under canon/rules or canon/decisions is reviewed (BR-2009): rule and
  // decision documents by their new text, deleted ones by the text they had on main, domain READMEs whole.
  // core.quotePath=false: git otherwise prints non-ASCII paths quoted and octal-escaped, which match no document.
  // A file only moved, with identical content, is neither changed nor deleted: moving 74 rules into
  // subdomains must not re-review all of them (BR-2009). git pairs exact renames; the blobs are compared too.
  const knowledge = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames=100%", base.value, head.value, "--", "canon/rules", "canon/decisions");
  const entries: { status: string; path: string }[] = [];
  const renamed: string[] = [];
  for (const l of knowledge.ok && knowledge.value !== "" ? knowledge.value.split("\n") : []) {
    const [status, from, to] = l.split("\t") as [string, string, string | undefined];
    if (status[0] !== "R" || to === undefined) entries.push({ status: status[0]!, path: from });
    else if (sameBlob(wt, `${base.value}:${from}`, `${head.value}:${to}`)) renamed.push(`${from} → ${to}`);
    else entries.push({ status: "D", path: from }, { status: "A", path: to });
  }
  if (renamed.length > 0) say(`review: ${renamed.length} file(s) only moved, not reviewed`);
  const live = new Set(entries.filter((e) => e.status !== "D").map((e) => e.path));
  const changedDocs = read.corpus.docs.filter((d) => live.has(d.path));
  const deleted: DeletedDoc[] = entries
    .filter((e) => e.status === "D" && e.path.endsWith(".md") && !e.path.endsWith("/README.md"))
    .map((e) => {
      const old = git(wt, "show", `${base.value}:${e.path}`);
      const id = e.path.split("/").pop()!.match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? e.path;
      return { id, path: e.path, text: old.ok ? old.value : "" };
    });
  // Sources new to main are checked once, here, on the tree that becomes main (BR-2111).
  const sourceFailures = await checkSources(wt, base.value, entries, read.corpus.docs, opts.fetcher ?? httpFetch);
  if (sourceFailures.length > 0) return refuse("source", `decision sources do not hold:\n${sourceFailures.map((f) => `  - ${f}`).join("\n")}`);
  const readmes = read.corpus.domains.filter((dom) => live.has(dom.path)).map((dom) => dom.name);
  const deletedReadmes = entries.filter((e) => e.status === "D" && e.path.endsWith("/README.md")).map((e) => e.path);
  const reviewed = [...changedDocs.map((d) => d.id), ...deleted.map((d) => `${d.id} (deleted)`), ...readmes.map((n) => `${n} README`), ...deletedReadmes.map((p) => `${p} (deleted)`)];
  let reviewNotes: { reviewed: string[]; notes: readonly string[] } | undefined;
  if (reviewed.length > 0) {
    if (!ws.config.review) {
      say(`review: not configured — ${reviewed.join(", ")} land without a rule review`);
      ws.db.event(ws.actor, "review.skip", subject, { docs: reviewed });
    } else {
      say(`review: ${reviewed.join(", ")}`);
      const v = await runReview(ws.config.review, wt, reviewPrompt(wt, read.corpus, changedDocs, { deleted, readmes, deletedReadmes, change: subject ? findDoc(read.corpus, subject) : undefined }));
      if (!v.ok) return refuse("review", `the rule review could not run: ${v.error.message}`);
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: reviewed, findings: v.value.findings });
      if (v.value.verdict === "block") return refuse("review", `rule review blocked:\n${v.value.findings.map((f) => `  - ${f}`).join("\n")}`);
      for (const f of v.value.findings) say(`review note: ${f}`);
      // reason: notes do not block and are not changes of their own; they wait on the document they name (BR-2145, D-21)
      reviewNotes = { reviewed: [...changedDocs.map((d) => d.id), ...deleted.map((d) => d.id)], notes: v.value.findings };
      if (v.value.findings.length > 0) say("review notes do not block and are not changes of their own: canon context shows them to whoever next changes these documents, who handles them then");
    }
  }
  // Standing instructions added or edited by this landing are reviewed for requirements stated twice (BR-2143).
  const touched = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=d", base.value, head.value);
  const standing = (touched.ok && touched.value !== "" ? touched.value.split("\n") : []).filter((p) => ws.config.instructions.includes(p) || SKILL_FILE.test(p));
  if (standing.length > 0) {
    if (!ws.config.review) {
      say(`review: not configured — ${standing.join(", ")} land without a duplicate review`);
      ws.db.event(ws.actor, "review.skip", subject, { docs: standing });
    } else {
      say(`review: standing instructions ${standing.join(", ")}`);
      const v = await runReview(ws.config.review, wt, duplicatePrompt(standing, standingText(wt, ws.config.instructions), opts.guide));
      if (!v.ok) return refuse("review", `the duplicate review could not run: ${v.error.message}`);
      ws.db.event(ws.actor, `review.${v.value.verdict}`, subject, { docs: standing, findings: v.value.findings });
      if (v.value.verdict === "block") return refuse("review", `duplicate review blocked:\n${v.value.findings.map((f) => `  - ${f}`).join("\n")}`);
      for (const f of v.value.findings) say(`review note: ${f}`);
    }
  }
  // before_land: after floor, canon check and the built-in review, on the exact tree that becomes main (BR-2057).
  const hookEnv = { CANON_BASE: base.value, CANON_HEAD: head.value, CANON_BRANCH: v.branch };
  const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "before_land", change: subject, cwd: wt, env: hookEnv }, ws.config.hooks.before_land, say, true);
  if (failed) return refuse("hook", `before_land \`${failed.command}\` exited ${failed.exit}\n${failed.output}`);
  return { ok: true, reviewNotes };
}

/**
 * The paths `base..head` changes, when every one is under a `floor_skip_paths` entry and none is a test file
 * (BR-2164); undefined when the floor must run. Renames count on both sides (`--no-renames`).
 */
export function floorSkip(wt: string, base: string, head: string): { paths: string[]; under: string[] } | undefined {
  // reason: the config of the tree that is landing decides, not the one read when the workspace opened, before
  // the rebase onto a main that may have changed floor_skip_paths or tests (BR-2164, issue #40).
  const read = readConfig(wt);
  if (!read.ok) return undefined;
  const config = read.value;
  if (config.floorSkipPaths.length === 0) return undefined;
  const d = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, head);
  if (!d.ok) return undefined;
  const paths = d.value === "" ? [] : d.value.split("\n");
  const under = new Set<string>();
  for (const p of paths) {
    const entry = config.floorSkipPaths.find((e) => p === e || p.startsWith(`${e}/`));
    if (!entry) return undefined;
    under.add(entry);
  }
  const tests = new Set(testFilesFor(wt, config));
  if (paths.some((p) => tests.has(p) || isTestPath(config, p))) return undefined;
  return { paths, under: [...under].sort() };
}

/** Whether a path matches a configured `tests` glob, so a deleted test file counts too (BR-2164). */
function isTestPath(config: Config, path: string): boolean {
  return (config.tests ?? []).some((g) => new Bun.Glob(g).match(path));
}

/**
 * A fingerprint of the change's own committed edits: the zero-context diff from its merge base with main to
 * HEAD, outside canon/changes, through `git patch-id`. A rebase onto a newer main leaves it unchanged; editing
 * code changes it. `canon stats` compares a refusal's fingerprint with the later landing's (BR-2068).
 */
export function ownDiffId(wt: string, main: string): string | null {
  const r = Bun.spawnSync(["sh", "-c", `base=$(git merge-base ${JSON.stringify(main)} HEAD) && git diff -U0 "$base" HEAD -- . ':(exclude)canon/changes' | git patch-id --stable`], { cwd: wt, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim().split(/\s+/)[0] || "empty";
}

/**
 * Compare-and-swap of main from `expected` to `next`. When a worktree has main checked out, it is
 * fast-forwarded in place so its files stay in step; it must be clean, or the swap is refused.
 */
/**
 * The environment variable naming the commit `canon work land` moves main to. The git guard canon installs
 * lets main move only to that commit (BR-2123); land sets it only on its own git command that moves main (BR-2125).
 */
export const LAND_MARKER = "CANON_LAND_MAIN";

function moveMain(ws: Workspace, expected: string, next: string): "moved" | { reason: "main-moved" | "main-dirty"; message: string } {
  const main = ws.config.main;
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return { reason: "main-moved", message: wts.error.message };
  const holder = wts.value.find((w) => w.branch === main);
  if (holder) {
    if (holder.head !== expected) return { reason: "main-moved", message: `${main} moved to ${holder.head.slice(0, 9)} during the landing; land again` };
    const clean = isClean(holder.path);
    if (!clean.ok || !clean.value) return { reason: "main-dirty", message: `${holder.path} has ${main} checked out with uncommitted changes; ${main} was not moved` };
    const ff = gitEnv(holder.path, { [LAND_MARKER]: next }, "merge", "-q", "--ff-only", next);
    return ff.ok ? "moved" : { reason: "main-moved", message: ff.error.message };
  }
  const r = gitEnv(ws.primary, { [LAND_MARKER]: next }, "update-ref", `refs/heads/${main}`, next, expected);
  return r.ok ? "moved" : { reason: "main-moved", message: `${main} moved during the landing; land again (${r.error.message})` };
}

/** Whether two `<rev>:<path>` objects are the same blob, i.e. the same bytes. */
function sameBlob(wt: string, a: string, b: string): boolean {
  const x = git(wt, "rev-parse", a);
  const y = git(wt, "rev-parse", b);
  return x.ok && y.ok && x.value === y.value;
}

/**
 * BR-2111: a decision added by this landing cites at least one source under its options, and every source
 * line not already on main (in that decision) is verified against what it names. A source that cannot be
 * fetched fails too: an unverified quote never reaches main.
 */
async function checkSources(wt: string, base: string, entries: readonly { status: string; path: string }[], docs: readonly Doc[], fetcher: Fetcher): Promise<string[]> {
  const failures: string[] = [];
  const touched = new Map(entries.filter((e) => e.status !== "D" && e.path.startsWith("canon/decisions/")).map((e) => [e.path, e.status]));
  for (const d of docs) {
    if (d.kind !== "decision" || !touched.has(d.path)) continue;
    const now = sources(d.body).sources;
    if (touched.get(d.path) === "A" && now.length === 0) {
      failures.push(`${d.id} is new and cites no source under ${OPTIONS_SECTION} (来源：<URL or repository path> “<quote>”)`);
      continue;
    }
    const old = git(wt, "show", `${base}:${d.path}`);
    const before = new Set(old.ok ? sources(old.value).sources.map((s) => `${s.target} ${s.quote}`) : []);
    for (const f of await verify(wt, now.filter((s) => !before.has(`${s.target} ${s.quote}`)), fetcher)) failures.push(`${d.id}: ${f}`);
  }
  return failures;
}
