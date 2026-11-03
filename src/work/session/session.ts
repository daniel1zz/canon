import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Say, Workspace } from "../workspace.ts";
import { holdClaim, unholdClaim, releaseClaim, releaseSubagentClaim, renewClaim, takeClaim } from "../claims/claims.ts";
import { writeHandoff } from "./handoffs.ts";
import { sessionProcess } from "../claims/liveness.ts";
import { runHooksSync } from "../../config/hooks.ts";
import { noticeOverlaps } from "./overlap.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { slugify, type Change, type Corpus } from "../../knowledge/documents/model.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { createDoc } from "../../knowledge/documents/write.ts";
import { worktreesDirOf } from "../../config/config.ts";
import { git, ignoredPaths, isClean, listWorktrees, unregenerable, type WorktreeInfo } from "../../kernel/git.ts";
import { processesIn, type Occupant } from "../../kernel/process.ts";

/**
 * The work flow (design §6): one change, one worktree, one agent from start to land. This part starts,
 * stops and cleans; landing is in ../land.
 * The only refusals here are outcome guards: a lease another worktree holds, uncommitted work that
 * would be lost, a red floor, a corrupt corpus, a main that moved underneath.
 */

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
    const corpus = readCorpus(path, ws.config.types, ws.config).corpus;
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
  if (holder) return ok(readCorpus(holder.path, ws.config.types, ws.config).corpus);
  const dir = mkdtempSync(join(tmpdir(), "canon-main-"));
  try {
    const hasCorpus = git(ws.primary, "cat-file", "-e", `${main}:canon`).ok;
    if (hasCorpus) {
      // reason: the ref can be a change branch, whose name may hold shell syntax; no shell sees it (BR-2107).
      const archive = Bun.spawnSync(["git", "archive", "--format=tar", main, "canon"], { cwd: ws.primary, stdout: "pipe", stderr: "pipe" });
      if (archive.exitCode !== 0) return err("io", `cannot read canon/ from ${main}: ${archive.stderr.toString().trim()}`);
      const tar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout, stderr: "pipe" });
      if (tar.exitCode !== 0) return err("io", `cannot read canon/ from ${main}: ${tar.stderr.toString().trim()}`);
    }
    return ok(readCorpus(dir, ws.config.types, ws.config).corpus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Allocates the change id up front so the worktree and branch can carry it. */
function createDocProbe(ws: Workspace, corpus: Corpus, _title: string): { id: string } {
  const max = corpus.docs.filter((d) => d.kind === "change").reduce((m, d) => Math.max(m, Number(d.id.split("-")[1])), 0);
  return { id: ws.db.allocate("C", max, ws.actor) };
}

/** Records where the change stands so the next session can continue without a human re-briefing (P3). */
export function stop(ws: Workspace, next: string, note: string | undefined, release: boolean, say: Say = () => {}, takeover = false): Result<string> {
  if (takeover && release) {
    // The main thread releases a claim of one of its own subagents, which no liveness probe can free (BR-2129).
    const taken = releaseSubagentClaim(ws.db, ws.root, ws.actor);
    if (!taken.ok) return taken;
    if (taken.value) {
      writeHandoff(ws.db, { subject: taken.value.subject, worktree: ws.root, actor: ws.actor, next, note: note ?? null });
      runHooksSync({ db: ws.db, actor: ws.actor, event: "after_stop", change: taken.value.subject, cwd: ws.root, env: { CANON_NEXT: next } }, ws.config.hooks.after_stop, say);
      return ok(taken.value.subject);
    }
  }
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
