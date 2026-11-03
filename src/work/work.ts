import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Workspace } from "../app/workspace.ts";
import { check, type Finding } from "../check/check.ts";
import { testFilesFor } from "../check/tests.ts";
import { claimOfWorktree, dropHandoff, holdClaim, unholdClaim, enqueue, failIfActive, finishEntry, heartbeat, keepClaim, releaseClaim, releaseOwnClaim, renewClaim, takeClaim, tryTurn, writeHandoff } from "../coord/state.ts";
import { selfProcess, sessionProcess } from "../coord/liveness.ts";
import { logFile, runHooks, runHooksInBackground, runHooksSync } from "../hooks/hooks.ts";
import { noticeOverlaps } from "./overlap.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { slugify, type Change, type Corpus } from "../knowledge/model.ts";
import { findDoc } from "../knowledge/query.ts";
import { readCorpus } from "../knowledge/read.ts";
import { createDoc, setMeta } from "../knowledge/write.ts";
import { worktreesDirOf } from "../repo/config.ts";
import { git, ignoredPaths, isClean, listWorktrees, unregenerable, type WorktreeInfo } from "../repo/git.ts";
import { processesIn, type Occupant } from "../repo/process.ts";
import { reviewPrompt, runReview, type DeletedDoc } from "../review/review.ts";

/**
 * The work flow (design §6): one change, one worktree, one agent from start to land.
 * The only refusals here are outcome guards: a lease another worktree holds, uncommitted work that
 * would be lost, a red floor, a corrupt corpus, a main that moved underneath.
 */
export type Say = (line: string) => void;

/**
 * Change worktrees live by default next to the primary checkout, in `<primary>.worktrees/<C-n>`: outside
 * every checkout, so no test run, scan or status of the project ever picks up a copy of it. `worktrees` in
 * canon/config.yaml moves them (BR-2047).
 */
export function worktreesDir(ws: Workspace): string {
  return worktreesDirOf(ws.config, ws.primary);
}

export interface Started {
  readonly change: string;
  readonly worktree: string;
  readonly branch: string;
  readonly created: boolean;
}

/**
 * Starts work on an existing change or on a new one (`title`), in its own worktree. An existing change is looked
 * up on main, and else on its own `change/C-n` branch: a change made with --title lives only there until it
 * lands, and a session that stopped without a handoff must still be able to resume it (BR-2107).
 */
export function start(ws: Workspace, target: { change: string } | { title: string; rules?: readonly string[] }, say: Say): Result<Started> {
  const main = ws.config.main;
  let changeId: string;
  let slug: string;
  let fresh = false;
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return onMain;
  let existing: { branch: string; worktree: string | undefined } | undefined;
  if ("change" in target) {
    let doc = findDoc(onMain.value, target.change);
    if (!doc || doc.kind !== "change") {
      const off = changeOffMain(ws, target.change.toUpperCase());
      if (!off.ok) return off;
      if (off.value) {
        doc = off.value.doc;
        existing = { branch: off.value.branch, worktree: off.value.worktree };
      }
    }
    if (!doc || doc.kind !== "change") {
      ws.db.event(ws.actor, "start.refuse", target.change, { reason: "not-found" });
      return err("not_found", `${target.change} is not a change on ${main} or on a change/${target.change} branch; start a new one with --title`);
    }
    if (doc.status !== "open") {
      ws.db.event(ws.actor, "start.refuse", doc.id, { reason: "not-open", status: doc.status });
      return err("invalid", `${doc.id} is ${doc.status}`);
    }
    changeId = doc.id;
    slug = slugify(doc.title);
  } else {
    const probe = createDocProbe(ws, onMain.value, target.title);
    changeId = probe.id;
    slug = slugify(target.title);
    fresh = true;
  }
  const branch = existing?.branch ?? (slug ? `change/${changeId}-${slug}` : `change/${changeId}`).slice(0, 80);
  const path = existing?.worktree ?? join(worktreesDir(ws), changeId);

  const claim = takeClaim(ws.db, changeId, path, ws.actor, ws.config.claimLeaseMs, sessionProcess());
  if (!claim.ok) return claim;

  let created = false;
  let hasBranch = false;
  if (!existsSync(path)) {
    hasBranch = git(ws.primary, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;
    const add = hasBranch ? git(ws.primary, "worktree", "add", path, branch) : git(ws.primary, "worktree", "add", "-b", branch, path, main);
    if (!add.ok) {
      releaseClaim(ws.db, changeId, ws.actor);
      return add;
    }
    created = true;
    if (ws.config.setup) {
      say(`setup: ${ws.config.setup}`);
      const r = Bun.spawnSync(["sh", "-c", ws.config.setup], { cwd: path, stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) {
        // The worktree was created a moment ago and holds nothing but the checkout: remove it so a retry runs setup again.
        git(ws.primary, "worktree", "remove", "--force", path);
        if (!hasBranch) git(ws.primary, "branch", "-q", "-D", branch);
        releaseClaim(ws.db, changeId, ws.actor);
        ws.db.event(ws.actor, "start.refuse", changeId, { reason: "setup", exit: r.exitCode });
        return err("refused", `setup command exited ${r.exitCode}; the new worktree was removed and ${changeId} released, so a retry starts clean`);
      }
    }
  }

  if (fresh && "title" in target) {
    const corpus = readCorpus(path, ws.config.types).corpus;
    const made = createDoc(path, corpus, ws.db, ws.actor, { kind: "change", title: target.title, rules: target.rules ?? [], id: changeId }, ws.config.templates);
    if (!made.ok) return made;
    const c = git(path, "add", made.value);
    if (!c.ok) return c;
    const m = git(path, "commit", "-q", "-m", `canon: open ${changeId} ${target.title}`);
    if (!m.ok) return m;
  }
  ws.db.event(ws.actor, "start.ok", changeId, { created, setup: created && ws.config.setup !== undefined });
  say(`${changeId} → ${path} (branch ${branch})`);
  noticeOverlaps(ws, path, changeId, "start", say);
  // after_start never changes the result (BR-2056): the worktree and claim stand whatever it exits with.
  runHooksSync({ db: ws.db, actor: ws.actor, event: "after_start", change: changeId, cwd: path, env: { CANON_BRANCH: branch } }, ws.config.hooks.after_start, say);
  return ok({ change: changeId, worktree: path, branch, created });
}

/**
 * The corpus as it is on main: read from the worktree that has main checked out, or else exported
 * from git, so a primary checkout on another branch is never mistaken for main.
 */
export function mainCorpus(ws: Workspace): Result<Corpus> {
  return corpusOf(ws, ws.config.main);
}

/**
 * A change that is not on main but on its own branch, `change/C-n` or `change/C-n-<slug>`: read from that
 * branch's worktree when it has one, else from the branch itself. Undefined when no such branch exists; more
 * than one is refused, since canon cannot tell which holds the work.
 */
function changeOffMain(ws: Workspace, id: string): Result<{ doc: Change; branch: string; worktree: string | undefined } | undefined> {
  const refs = git(ws.primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/");
  if (!refs.ok) return refs;
  const branches = refs.value.split("\n").filter((b) => b === `change/${id}` || b.startsWith(`change/${id}-`));
  if (branches.length === 0) return ok(undefined);
  if (branches.length > 1) return err("invalid", `${id} has more than one branch (${branches.join(", ")}); remove the stray ones with \`canon work drop\` first`);
  const branch = branches[0]!;
  const corpus = corpusOf(ws, branch);
  if (!corpus.ok) return corpus;
  const doc = findDoc(corpus.value, id);
  if (!doc || doc.kind !== "change") return ok(undefined);
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return wts;
  return ok({ doc, branch, worktree: wts.value.find((w) => w.branch === branch)?.path });
}

/** The corpus as committed on a branch, or as it stands in the worktree that has the branch checked out. */
function corpusOf(ws: Workspace, ref: string): Result<Corpus> {
  const main = ref;
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return wts;
  const holder = wts.value.find((w) => w.branch === main);
  if (holder) return ok(readCorpus(holder.path, ws.config.types).corpus);
  const dir = mkdtempSync(join(tmpdir(), "canon-main-"));
  try {
    const hasCorpus = git(ws.primary, "cat-file", "-e", `${main}:canon`).ok;
    if (hasCorpus) {
      const tar = Bun.spawnSync(["sh", "-c", `git archive ${JSON.stringify(main)} canon | tar -x -C ${JSON.stringify(dir)}`], { cwd: ws.primary, stderr: "pipe" });
      if (tar.exitCode !== 0) return err("io", `cannot read canon/ from ${main}: ${tar.stderr.toString().trim()}`);
    }
    return ok(readCorpus(dir, ws.config.types).corpus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Allocates the change id up front so the worktree and branch can carry it. */
function createDocProbe(ws: Workspace, corpus: Corpus, _title: string): { id: string } {
  const max = corpus.docs.filter((d) => d.kind === "change").reduce((m, d) => Math.max(m, Number(d.id.split("-")[1])), 0);
  return { id: ws.db.allocate("C", max, ws.actor) };
}

export interface LandOptions {
  /** Close the change (status done) and remove its worktree after landing. */
  readonly finish: boolean;
  /** Give up waiting for the queue after this long. */
  readonly timeoutMs: number;
}

export type LandOutcome =
  | { readonly kind: "landed"; readonly sha: string; readonly change: string | null; readonly finished: boolean }
  | { readonly kind: "refused"; readonly reason: "claimed" | "dirty" | "conflict" | "floor" | "check" | "review" | "hook" | "moved-during-land" | "main-moved" | "main-dirty" | "no-floor" | "no-claim" | "on-main"; readonly message: string; readonly findings?: readonly Finding[] }
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

  if (opts.finish) {
    if (!subject) return early("no-claim", "--finish needs a claimed change; this worktree holds none");
    const corpus = readCorpus(wt, ws.config.types).corpus;
    const doc = findDoc(corpus, subject);
    if (doc?.kind === "change" && doc.status === "open") {
      const s = setMeta(wt, doc, { status: "done" });
      if (!s.ok) return early("check", s.error.message);
      git(wt, "add", doc.path);
      const c = git(wt, "commit", "-q", "-m", `canon: close ${subject}`);
      if (!c.ok) return early("check", c.error.message);
    }
  }

  // Same-file overlap with other changes in flight: a notice only, never a refusal (BR-2062).
  noticeOverlaps(ws, wt, subject, "land", say);
  const entry = enqueue(ws.db, wt, subject, ws.actor, selfProcess());
  const running: Running = {};
  // A lander killed by a signal (a tool timeout, Ctrl-C) gives its turn up at once and leaves no rebase half done (BR-2099).
  const onSignal = (signal: NodeJS.Signals) => {
    running.floor?.kill();
    const aborted = rebaseInProgress(wt) && git(wt, "rebase", "--abort").ok;
    // A signal after main moved leaves the landed entry as it is: the landing happened.
    // reason: an interruption, not a check's verdict, so it is its own event kind and no check in `canon stats` (BR-2067).
    if (failIfActive(ws.db, entry, "killed")) ws.db.event(ws.actor, "land.killed", subject, { signal, rebaseAborted: aborted });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    return await queueAndLand(ws, opts, say, { entry, subject, branch: branch.value, running });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
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
  let lastAhead = -1;
  for (;;) {
    const turn = tryTurn(ws.db, entry, ws.config.landerStaleMs);
    if (turn.mine) break;
    if (turn.ahead !== lastAhead) say(`waiting: ${turn.ahead} landing(s) ahead`);
    lastAhead = turn.ahead;
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

  const read = readCorpus(wt, ws.config.types);
  const tests = testFilesFor(wt, ws.config);
  const findings = check({ root: wt, ...read, testFiles: tests });
  if (findings.length > 0) return refuse("check", `canon check: ${findings.length} finding(s)`, findings);

  const head = tested;

  // Every added, edited or deleted file under canon/rules or canon/decisions is reviewed (BR-2009): rule and
  // decision documents by their new text, deleted ones by the text they had on main, domain READMEs whole.
  // core.quotePath=false: git otherwise prints non-ASCII paths quoted and octal-escaped, which match no document.
  const knowledge = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", base.value, head.value, "--", "canon/rules", "canon/decisions");
  const entries = knowledge.ok && knowledge.value !== "" ? knowledge.value.split("\n").map((l) => ({ status: l[0]!, path: l.slice(l.indexOf("\t") + 1) })) : [];
  const live = new Set(entries.filter((e) => e.status !== "D").map((e) => e.path));
  const changedDocs = read.corpus.docs.filter((d) => live.has(d.path));
  const deleted: DeletedDoc[] = entries
    .filter((e) => e.status === "D" && e.path.endsWith(".md") && !e.path.endsWith("/README.md"))
    .map((e) => {
      const old = git(wt, "show", `${base.value}:${e.path}`);
      const id = e.path.split("/").pop()!.match(/^[A-Z][A-Z0-9]*-\d+/)?.[0] ?? e.path;
      return { id, path: e.path, text: old.ok ? old.value : "" };
    });
  const readmes = read.corpus.domains.filter((dom) => live.has(dom.path)).map((dom) => dom.name);
  const deletedReadmes = entries.filter((e) => e.status === "D" && e.path.endsWith("/README.md")).map((e) => e.path);
  const reviewed = [...changedDocs.map((d) => d.id), ...deleted.map((d) => `${d.id} (deleted)`), ...readmes.map((n) => `${n} README`), ...deletedReadmes.map((p) => `${p} (deleted)`)];
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
  const fingerprint = ownDiffId(wt, main); // before main moves: afterwards the merge base is HEAD itself
  const moved = moveMain(ws, base.value, head.value);
  if (moved !== "moved") return refuse(moved.reason, moved.message);

  finishEntry(ws.db, entry, "landed", head.value);
  ws.db.event(ws.actor, "land.ok", subject, { sha: head.value, branch: t.branch, diff: fingerprint });
  say(`landed ${head.value.slice(0, 9)} on ${main}`);
  if (ws.config.hooks.after_land.length > 0) {
    const log = runHooksInBackground({ db: ws.db, actor: ws.actor, event: "after_land", change: subject, cwd: ws.primary, env: hookEnv }, ws.config.hooks.after_land, logFile(ws.db, `after-land-${entry}.log`));
    say(`after_land running in the background (log: ${log})`);
  }

  let finished = false;
  if (opts.finish && subject) {
    // Another session that took the change over meanwhile keeps its claim and its handoff (BR-2108).
    if (releaseOwnClaim(ws.db, subject, ws.root, ws.actor)) dropHandoff(ws.db, subject);
    else say(`${subject} is claimed by another session now; its claim and handoff were left as they are`);
    finished = true;
    say(`${subject} closed; remove the worktree with \`canon work clean\` once you have left it`);
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
function moveMain(ws: Workspace, expected: string, next: string): "moved" | { reason: "main-moved" | "main-dirty"; message: string } {
  const main = ws.config.main;
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return { reason: "main-moved", message: wts.error.message };
  const holder = wts.value.find((w) => w.branch === main);
  if (holder) {
    if (holder.head !== expected) return { reason: "main-moved", message: `${main} moved to ${holder.head.slice(0, 9)} during the landing; land again` };
    const clean = isClean(holder.path);
    if (!clean.ok || !clean.value) return { reason: "main-dirty", message: `${holder.path} has ${main} checked out with uncommitted changes; ${main} was not moved` };
    const ff = git(holder.path, "merge", "-q", "--ff-only", next);
    return ff.ok ? "moved" : { reason: "main-moved", message: ff.error.message };
  }
  const r = git(ws.primary, "update-ref", `refs/heads/${main}`, next, expected);
  return r.ok ? "moved" : { reason: "main-moved", message: `${main} moved during the landing; land again (${r.error.message})` };
}

/** Records where the change stands so the next session can continue without a human re-briefing (P3). */
export function stop(ws: Workspace, next: string, note: string | undefined, release: boolean, say: Say = () => {}): Result<string> {
  // Release too goes through the holder check: only the holder lets its claim go (BR-2104).
  const renewed = renewClaim(ws.db, ws.root, ws.actor, ws.config.claimLeaseMs, sessionProcess());
  if (!renewed.ok) return renewed;
  const claim = renewed.value;
  if (!claim) return err("not_found", "this worktree holds no change; nothing to hand off");
  writeHandoff(ws.db, { subject: claim.subject, worktree: ws.root, actor: ws.actor, next, note: note ?? null });
  if (release) releaseClaim(ws.db, claim.subject, ws.actor);
  // after_stop runs once the handoff is recorded and never changes the result (BR-2058).
  runHooksSync({ db: ws.db, actor: ws.actor, event: "after_stop", change: claim.subject, cwd: ws.root, env: { CANON_NEXT: next } }, ws.config.hooks.after_stop, say);
  return ok(claim.subject);
}

/**
 * Removes finished worktrees: a worktree is removed only when it is clean, holds no ignored file that cannot
 * be regenerated, has no process inside it, and its branch is fully contained in main, so no work can be lost
 * (P4, BR-2019). Anything else is listed with the reason it stays.
 */
export function clean(ws: Workspace, say: Say): Result<{ removed: string[]; kept: string[] }> {
  const wts = listWorktrees(ws.primary);
  if (!wts.ok) return wts;
  const removed: string[] = [];
  const kept: string[] = [];
  const held = new Set(ws.db.db.query<{ worktree: string }, []>("SELECT worktree FROM claims").all().map((r) => r.worktree));
  const candidates: WorktreeInfo[] = [];
  for (const w of wts.value) {
    if (!w.path.startsWith(worktreesDir(ws) + "/")) continue;
    const why = keepReason(ws, w, held);
    if (why) kept.push(`${w.path}: ${why}`);
    else candidates.push(w);
  }
  // One process listing for all candidates: lsof scans every process each time it runs.
  const occupied = candidates.length > 0 ? processesIn(candidates.map((w) => w.path)) : ok(new Map<string, Occupant[]>());
  for (const w of candidates) {
    if (!occupied.ok) {
      kept.push(`${w.path}: cannot tell whether a process is inside it (${occupied.error.message})`);
      continue;
    }
    const inside = occupied.value.get(w.path) ?? [];
    if (inside.length > 0) {
      kept.push(`${w.path}: in use by ${describeOccupants(inside)}`);
      continue;
    }
    // reason: the claims were read before the checks and lsof; a start may have claimed it since (issue #12).
    // Holding the claim row atomically until the removal is done closes that window (BR-2019).
    const subject = basename(w.path);
    const hold = holdClaim(ws.db, subject, w.path, ws.actor, true, ws.config.claimLeaseMs);
    if (!hold.ok) {
      kept.push(`${w.path}: claimed`);
      continue;
    }
    try {
      // reason: without --force, so git itself still refuses if the worktree changed since the checks above.
      const rm = git(ws.primary, "worktree", "remove", w.path);
      if (!rm.ok) {
        kept.push(`${w.path}: ${rm.error.message}`);
        continue;
      }
      if (w.branch) git(ws.primary, "branch", "-q", "-d", w.branch);
    } finally {
      unholdClaim(ws.db, hold.value);
    }
    removed.push(w.path);
    say(`removed ${w.path}`);
  }
  return ok({ removed, kept });
}

/** Why `clean` must keep a worktree, cheapest check first; undefined when only the process check remains. */
function keepReason(ws: Workspace, w: WorktreeInfo, held: ReadonlySet<string>): string | undefined {
  if (w.path === ws.root) return "you are in it";
  if (held.has(w.path)) return "claimed";
  const c = isClean(w.path);
  if (!c.ok || !c.value) return "uncommitted changes";
  const ahead = git(ws.primary, "rev-list", "--count", `${ws.config.main}..${w.head}`);
  if (!ahead.ok || ahead.value !== "0") return `${ahead.ok ? ahead.value : "?"} commit(s) not on ${ws.config.main}`;
  // `git status` and `git worktree remove` both ignore git-ignored files, so a `.env` would vanish silently.
  const ignored = ignoredPaths(w.path);
  if (!ignored.ok) return `cannot list ignored files (${ignored.error.message})`;
  const work = unregenerable(ignored.value, ws.config.regenerable);
  if (work.length > 0) return `ignored files that cannot be regenerated: ${work.join(", ")} (if they can be, add their names to \`regenerable\` in canon/config.yaml)`;
  return undefined;
}

export function describeOccupants(list: readonly Occupant[]): string {
  return list.map((o) => `pid ${o.pid} (${o.command})`).join(", ");
}

export type { Change };
