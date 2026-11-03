import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../workspace.ts";
import { check, type Finding } from "../../knowledge/check/check.ts";
import { httpFetch, OPTIONS_SECTION, sources, verify, type Fetcher } from "../../knowledge/check/sources.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import { bindToLander, keepClaim, releaseOwnClaim, renewClaim, unbindFromLander } from "../claims/claims.ts";
import { dropHandoff } from "../session/handoffs.ts";
import { enqueue, failIfActive, finishEntry, heartbeat, holdsTurn, tryTurn } from "./queue.ts";
import { selfProcess, sessionProcess } from "../claims/liveness.ts";
import { logFile, runHooks, runHooksInBackground } from "../../config/hooks.ts";
import { noticeOverlaps } from "../session/overlap.ts";
import { type Doc } from "../../knowledge/documents/model.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { setMeta } from "../../knowledge/documents/write.ts";
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
  | { readonly kind: "refused"; readonly reason: "claimed" | "dirty" | "conflict" | "floor" | "check" | "source" | "review" | "hook" | "moved-during-land" | "main-moved" | "main-dirty" | "lost-turn" | "no-floor" | "no-claim" | "on-main"; readonly message: string; readonly findings?: readonly Finding[] }
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
  const entry = enqueue(ws.db, wt, subject, ws.actor, lander);
  // The claim names this lander until the landing ends, so the session exiting meanwhile frees it to no one (BR-2142, issue #17).
  const bound = lander ? bindToLander(ws.db, wt, ws.actor, lander) : undefined;
  const running: Running = {};
  // A lander killed by a signal (a tool timeout, Ctrl-C) gives its turn up at once and leaves no rebase half done (BR-2099).
  const onSignal = (signal: NodeJS.Signals) => {
    running.floor?.kill();
    const aborted = rebaseInProgress(wt) && git(wt, "rebase", "--abort").ok;
    // A signal after main moved leaves the landed entry as it is: the landing happened.
    // reason: an interruption, not a check's verdict, so it is its own event kind and no check in `canon stats` (BR-2067).
    if (failIfActive(ws.db, entry, "killed")) {
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
interface CloseCommit {
  readonly subject: string;
  readonly path: string;
}

const closeSubject = (change: string) => `canon: close ${change}`;

/**
 * Takes the close commit back out after a landing that did not reach main: only while it is still the top
 * commit and changes nothing but the change file, with `git reset --keep`, which never drops local edits (BR-2018).
 */
function reopen(wt: string, close: CloseCommit, say: Say): void {
  const top = git(wt, "log", "-1", "--format=%s", "HEAD");
  const files = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "HEAD~1", "HEAD");
  if (!top.ok || top.value !== closeSubject(close.subject) || !files.ok || files.value !== close.path) {
    say(`${close.subject} still has its close commit somewhere below HEAD; it says done although it did not land`);
    return;
  }
  const r = git(wt, "reset", "-q", "--keep", "HEAD~1");
  say(r.ok ? `${close.subject} reopened: the landing did not reach main, so its close commit was taken back` : `${close.subject} could not be reopened (${r.error.message}); it says done although it did not land`);
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
        const message = `while waiting to land: a merge with ${main} ${tip.value.slice(0, 9)} conflicts in: ${files.join(", ")}\nResolve with \`git rebase ${main}\` in ${wt}, then land again.`;
        finishEntry(ws.db, entry, "failed", `conflict: ${message.slice(0, 500)}`);
        ws.db.event(ws.actor, "land.refuse", subject, { reason: "conflict", message: message.slice(0, 2000), early: true, diff: ownDiffId(wt, main) });
        return { kind: "refused", reason: "conflict", message };
      }
    }
    if (Date.now() > deadline) {
      finishEntry(ws.db, entry, "failed", "timeout");
      ws.db.event(ws.actor, "land.refuse", subject, { reason: "timeout", ahead: turn.ahead, diff: ownDiffId(wt, main) });
      return { kind: "timeout", ahead: turn.ahead };
    }
    await Bun.sleep(2000);
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
  const refuse = (reason: Extract<LandOutcome, { kind: "refused" }>["reason"], message: string, findings?: readonly Finding[]): LandOutcome => {
    finishEntry(ws.db, entry, "failed", `${reason}: ${message.slice(0, 500)}`);
    ws.db.event(ws.actor, "land.refuse", subject, { reason, message: message.slice(0, 2000), diff: ownDiffId(wt, main), ...(findings ? findingDetail(findings) : {}) });
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

  say(`floor: ${ws.config.floor}`);
  const logPath = join(dirname(ws.db.db.filename), "logs", `land-${entry}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  const proc = Bun.spawn(["sh", "-c", ws.config.floor!], { cwd: wt, stdout: fd, stderr: fd });
  t.running.floor = proc;
  const code = await proc.exited;
  t.running.floor = undefined;
  closeSync(fd);
  if (code !== 0) {
    const tail = readFileSync(logPath, "utf8").split("\n").slice(-40).join("\n");
    return refuse("floor", `floor exited ${code} (full log: ${logPath})\n${tail}`);
  }

  const read = readCorpus(wt, ws.config.types, ws.config);
  const tests = testFilesFor(wt, ws.config);
  const findings = check({ root: wt, ...read, testFiles: tests });
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);

  const head = tested;

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
      const v = await runReview(ws.config.review, wt, reviewPrompt(wt, read.corpus, changedDocs, { deleted, readmes, deletedReadmes }));
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
  const hookEnv = { CANON_BASE: base.value, CANON_HEAD: head.value, CANON_BRANCH: t.branch };
  const failed = await runHooks({ db: ws.db, actor: ws.actor, event: "before_land", change: subject, cwd: wt, env: hookEnv }, ws.config.hooks.before_land, say, true);
  if (failed) return refuse("hook", `before_land \`${failed.command}\` exited ${failed.exit}\n${failed.output}`);
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
  ws.db.event(ws.actor, "land.ok", subject, { sha: head.value, branch: t.branch, diff: fingerprint, ...(reviewNotes ?? {}) });
  say(`landed ${head.value.slice(0, 9)} on ${main}`);
  if (ws.config.hooks.after_land.length > 0) {
    const log = runHooksInBackground({ db: ws.db, actor: ws.actor, event: "after_land", change: subject, cwd: ws.primary, env: hookEnv }, ws.config.hooks.after_land, logFile(ws.db, `after-land-${entry}.log`), entry);
    say(`after_land running in the background (log: ${log})`);
  }

  let finished = false;
  if (opts.finish && subject) {
    // Another session that took the change over meanwhile keeps its claim and its handoff (BR-2108).
    if (releaseOwnClaim(ws.db, subject, ws.root, ws.actor)) dropHandoff(ws.db, subject);
    else say(`${subject} is claimed by another session now; its claim and handoff were left as they are`);
    finished = true;
    say(`${subject} closed; remove the worktree with \`canon work clean ${subject}\` once you have left it`);
  }
  return { kind: "landed", sha: head.value, change: subject, finished };
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
