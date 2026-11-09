import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Say, Workspace } from "../workspace.ts";
import { deletionOf, holdClaim, liveClaims, unholdClaim, releaseClaim, releaseOwnClaim, renewClaim, takeClaim } from "../claims/claims.ts";
import { writeHandoff } from "./handoffs.ts";
import { sessionProcess } from "../claims/liveness.ts";
import { runHooksSync } from "../hooks/hooks.ts";
import { inFlight, noticeOverlaps } from "./overlap.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { slugify, type Change, type Corpus } from "../../knowledge/documents/model.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { planProblem } from "../../knowledge/plans/link.ts";
import { createDoc, highestNumber } from "../../knowledge/documents/write.ts";
import { worktreesDirOf } from "./config-keys.ts";
import { noPort, portFor, type PortLookup } from "../hooks/ports.ts";
import { firstCommitStep, mainIsUnborn, addWorktree, git, ignoredPaths, isClean, listWorktreesLocked, removeWorktree, unregenerable, type WorktreeInfo } from "../../kernel/git.ts";
import { GENERATED_DIR } from "../../invocation/reference/reference.ts";
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
export function start(ws: Workspace, target: { change: string } | { title: string; rules?: readonly string[]; plan?: { id: string; steps: readonly string[] } }, say: Say): Result<Started> {
  const main = ws.config.main;
  // reason: BR-2012 — checked before an id is allocated or git is called, so a repository with no commit yet loses no number (BR-2002)
  if (mainIsUnborn(ws.primary, main)) return err("io", `${main} has no commit yet, so no change can start: ${firstCommitStep(main)}`);
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
    // reason: done only on its own branch means its landing never reached main (killed mid-way); it is resumed to land (BR-2294)
    if (doc.status !== "open" && !(existing && doc.status === "done")) {
      ws.db.event(ws.actor, "start.refuse", doc.id, { reason: "not-open", status: doc.status });
      return err("invalid", `${doc.id} is ${doc.status}`);
    }
    changeId = doc.id;
    slug = slugify(doc.title);
  } else {
    // reason: checked before an id is allocated, so a refused start leaves no number, worktree or claim behind (BR-2376, BR-2002)
    const bad = target.plan ? planProblem(onMain.value, ws.config.main, target.plan) : undefined;
    if (bad) {
      ws.db.event(ws.actor, "start.refuse", target.plan!.id, { reason: "plan" });
      return err("not_found", bad);
    }
    const probe = createDocProbe(ws, onMain.value, target.title);
    changeId = probe.id;
    slug = slugify(target.title);
    fresh = true;
  }
  const branch = existing?.branch ?? (slug ? `change/${changeId}-${slug}` : `change/${changeId}`).slice(0, 80);
  const path = existing?.worktree ?? join(worktreesDir(ws), changeId);

  const claim = takeClaim(ws.db, changeId, path, ws.actor, ws.config.claimLeaseMs, sessionProcess());
  if (!claim.ok) return claim;
  // reason: the branch was read before the claim; a drop that held the claim meanwhile may have deleted it.
  // Seen after the claim, the branch is as a finished or not-yet-started drop leaves it (BR-2136, issue #20).
  if (existing && !git(ws.primary, "rev-parse", "--verify", "--quiet", `refs/heads/${existing.branch}`).ok) {
    releaseOwnClaim(ws.db, changeId, path, ws.actor);
    ws.db.event(ws.actor, "start.refuse", changeId, { reason: "gone", branch: existing.branch });
    return err("not_found", `${changeId} was removed while starting: its branch ${existing.branch} no longer exists`);
  }

  let created = false;
  let hasBranch = false;
  if (!existsSync(path)) {
    hasBranch = git(ws.primary, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;
    // reason: BR-2132 — branch from the local main, never a remote-tracking ref, and with --no-track: either way git
    // would write upstream config (branch.autoSetupMerge=always tracks a local start point too, issue #27) and lock .git/config.
    // reason: BR-2223 — addWorktree, not plain git: concurrent adds read each other's half-made .git/worktrees/<id> (issue #32).
    const add = hasBranch ? addWorktree(ws.primary, path, branch) : addWorktree(ws.primary, "--no-track", "-b", branch, path, main);
    if (!add.ok) {
      releaseClaim(ws.db, changeId, ws.actor);
      ws.db.event(ws.actor, "start.refuse", changeId, { reason: "worktree", error: add.error.message });
      return add;
    }
    created = true;
  }
  // reason: the port is taken once the worktree exists and before setup, so setup sees it (BR-2267, D-41); a full range
  // does not stop the start, since most changes run nothing that needs a port (BR-2269, D-48)
  const port = ws.config.ports ? portFor(ws.db, ws.actor, changeId, ws.config.ports, path) : ok(undefined);
  if (!port.ok) say(`start: CANON_PORT is empty: ${port.error.message}`);
  const portLookup: PortLookup = () => port;
  if (created) {
    if (ws.config.setup) {
      say(`setup: ${ws.config.setup}`);
      const env = { ...(process.env as Record<string, string>), CANON_PORT: port.ok && port.value !== undefined ? String(port.value) : "" };
      const r = Bun.spawnSync(["sh", "-c", ws.config.setup], { cwd: path, env, stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) {
        undoStart(ws, changeId, path, branch, !hasBranch);
        ws.db.event(ws.actor, "start.refuse", changeId, { reason: "setup", exit: r.exitCode });
        return err("refused", `setup command exited ${r.exitCode}; the new worktree was removed and ${changeId} released, so a retry starts clean`);
      }
    }
  }

  if (fresh && "title" in target) {
    const corpus = readCorpus(path, ws.config.types, ws.config).corpus;
    const made = createDoc(path, corpus, ws.db, ws.actor, { kind: "change", title: target.title, rules: target.rules ?? [], ...(target.plan ? { plan: target.plan } : {}), id: changeId }, ws.config.templates);
    const commit = (file: string): Result<unknown> => {
      const a = git(path, "add", file);
      return a.ok ? git(path, "commit", "-q", "-m", `canon: open ${changeId} ${target.title}`) : a;
    };
    const committed = made.ok ? commit(made.value) : made;
    if (!committed.ok) {
      // reason: a new change whose file is not committed is half made; undo the worktree, branch and claim like a failed setup (BR-2029)
      if (created) undoStart(ws, changeId, path, branch, !hasBranch);
      else releaseClaim(ws.db, changeId, ws.actor);
      ws.db.event(ws.actor, "start.refuse", changeId, { reason: "change-file", error: committed.error.message });
      return err(committed.error.code, `${committed.error.message}; the new worktree was removed and ${changeId} released, so a retry starts clean`);
    }
  }
  ws.db.event(ws.actor, "start.ok", changeId, { created, setup: created && ws.config.setup !== undefined });
  say(`${changeId} → ${path} (branch ${branch})`);
  noticeOverlaps(ws, path, changeId, "start", say);
  // Where the other changes in flight work, so the session sees it before it has changed anything to compare (BR-2394).
  const flying = inFlight(ws, path);
  for (const u of flying.unreadable) say(`in flight: ${u}`);
  for (const line of flying.lines) say(line);
  // after_start never changes the result (BR-2056): the worktree and claim stand whatever it exits with.
  runHooksSync({ db: ws.db, actor: ws.actor, event: "after_start", change: changeId, cwd: path, env: { CANON_BRANCH: branch }, port: portLookup }, ws.config.hooks.after_start, say);
  return ok({ change: changeId, worktree: path, branch, created });
}

/** Undoes a start whose worktree was created a moment ago and holds nothing but the checkout, so a retry starts clean (BR-2029). */
function undoStart(ws: Workspace, changeId: string, path: string, branch: string, newBranch: boolean): void {
  removeWorktree(ws.primary, "--force", path);
  if (newBranch) git(ws.primary, "branch", "-q", "-D", branch);
  releaseClaim(ws.db, changeId, ws.actor);
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
export function changeOffMain(ws: Workspace, id: string): Result<{ doc: Change; branch: string; worktree: string | undefined } | undefined> {
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
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return wts;
  return ok({ doc, branch, worktree: wts.value.find((w) => w.branch === branch)?.path });
}

/** The corpus as committed on a branch, or as it stands in the worktree that has the branch checked out. */
export function corpusOf(ws: Workspace, ref: string): Result<Corpus> {
  const main = ref;
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return wts;
  const holder = wts.value.find((w) => w.branch === main);
  if (holder) return ok(readCorpus(holder.path, ws.config.types, ws.config).corpus);
  // reason: a ref git cannot read (no such branch, missing objects) is an environment failure, exit 4; only a
  // readable ref without canon/ reads as an empty corpus (BR-2022, issue #77).
  const readable = git(ws.primary, "rev-parse", "--verify", "--quiet", `${main}^{commit}`);
  if (!readable.ok) return err("io", `git cannot read ${main}: no such commit or branch (check \`main\` in canon/config.yaml)`);
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
  return { id: ws.db.allocate("C", highestNumber(corpus, "C"), ws.actor) };
}

/** Records where the change stands so the next session can continue without a human re-briefing (P3). */
/**
 * The last line of `canon work stop` and of `canon work land --finish` (BR-2163): a lesson goes into the change's
 * 教训 section, and becomes a mechanism only once the owner confirms it (D-24).
 */
export const LESSON_REMINDER =
  "lessons: if this work taught something about the process or tools that could become a mechanism (a rule, check or command) beyond this change, record it under ## 教训 in the change file and ask the owner before making it one; the rules, tests and checks this change wrote for its own feature or fix are not lessons";

export function stop(ws: Workspace, next: string, note: string | undefined, release: boolean, say: Say = () => {}): Result<string> {
  // Release too goes through the holder check: only the holder lets its claim go (BR-2104).
  const renewed = renewClaim(ws.db, ws.root, ws.actor, ws.config.claimLeaseMs, sessionProcess());
  if (!renewed.ok) return renewed;
  const claim = renewed.value;
  if (!claim) {
    // reason: a clean or drop removing this worktree replaced its claim with a hold; say so instead of "no change" (BR-2025)
    const going = deletionOf(ws.db, ws.root);
    if (going) return err("conflict", `${going.subject}'s worktree ${ws.root} is being deleted by \`canon work clean\` or \`canon work drop\` right now; nothing was recorded`);
    return err("not_found", "this worktree holds no change; nothing to hand off");
  }
  writeHandoff(ws.db, { subject: claim.subject, worktree: ws.root, actor: ws.actor, next, note: note ?? null });
  if (release) releaseClaim(ws.db, claim.subject, ws.actor);
  // after_stop runs once the handoff is recorded and never changes the result (BR-2058).
  runHooksSync({ db: ws.db, actor: ws.actor, event: "after_stop", change: claim.subject, cwd: ws.root, env: { CANON_NEXT: next }, port: ws.config.ports ? () => portFor(ws.db, ws.actor, claim.subject, ws.config.ports!, ws.root) : noPort }, ws.config.hooks.after_stop, say);
  return ok(claim.subject);
}

/**
 * Removes finished worktrees: a worktree is removed only when it is clean, holds no ignored file that cannot
 * be regenerated, has no process inside it, and its branch is fully contained in main, so no work can be lost
 * (P4, BR-2019). Anything else is listed with the reason it stays.
 */
/**
 * Removes the change worktrees that cannot lose work (BR-2019). With `only`, just those changes' worktrees
 * (BR-2152): every name must be a change, or nothing is removed; a named change without a worktree is kept, saying so.
 */
export function clean(ws: Workspace, say: Say, only?: readonly string[]): Result<{ removed: string[]; kept: string[] }> {
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return wts;
  const removed: string[] = [];
  const kept: string[] = [];
  const ours = wts.value.filter((w) => w.path.startsWith(worktreesDir(ws) + "/"));
  let named: Set<string> | undefined;
  if (only !== undefined && only.length > 0) {
    // reason: ids are matched as `canon work start` matches them, whatever their case; messages keep the name as typed (BR-2152, issue #54)
    const typed = new Map<string, string>();
    for (const name of only) if (!typed.has(name.toUpperCase())) typed.set(name.toUpperCase(), name);
    named = new Set(typed.keys());
    const withWorktree = new Set(ours.map((w) => basename(w.path)));
    let onMain: Corpus | undefined;
    for (const id of named) {
      if (withWorktree.has(id)) continue;
      if (!onMain) {
        const c = mainCorpus(ws);
        if (!c.ok) return c;
        onMain = c.value;
      }
      if (findDoc(onMain, id)?.kind === "change") {
        kept.push(`${id}: no worktree`);
        continue;
      }
      const off = changeOffMain(ws, id);
      if (!off.ok) return off;
      if (!off.value) return err("not_found", `${typed.get(id)} is not a change: nothing was removed`);
      kept.push(`${id}: no worktree`);
    }
  }
  // reason: only a claim that still binds keeps a worktree, judged as `canon work start` judges it; an expired or
  // abandoned claim is one start would take over (BR-2019, BR-2100).
  const held = new Set(liveClaims(ws.db).map((c) => c.holder));
  const candidates: WorktreeInfo[] = [];
  for (const w of ours) {
    if (named && !named.has(basename(w.path))) continue;
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
    const hold = holdClaim(ws.db, subject, w.path, ws.actor, ws.config.claimLeaseMs);
    if (!hold.ok) {
      kept.push(`${w.path}: claimed`);
      continue;
    }
    let gone = false;
    try {
      // reason: without --force, so git itself still refuses if the worktree changed since the checks above.
      const rm = removeWorktree(ws.primary, w.path);
      if (!rm.ok) {
        kept.push(`${w.path}: ${rm.error.message}`);
        continue;
      }
      gone = true;
      if (w.branch) deleteLandedBranch(ws, w.branch);
    } finally {
      // reason: a claim that no longer bound goes with its worktree; putting it back would name a removed worktree (BR-2019)
      unholdClaim(ws.db, gone ? { ...hold.value, prior: null } : hold.value);
    }
    removed.push(w.path);
    say(`removed ${w.path}`);
  }
  return ok({ removed, kept });
}

/**
 * Deletes a removed worktree's branch once it is fully contained in main, whatever the primary checkout has out:
 * `git branch -d` judges against HEAD and so kept landed branches when the primary was on another branch (BR-2188).
 * Compare-and-delete at the tip just checked, so a commit made on it meanwhile keeps the branch. Silent either way.
 */
function deleteLandedBranch(ws: Workspace, branch: string): void {
  const tip = git(ws.primary, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
  if (!tip.ok) return;
  if (!git(ws.primary, "merge-base", "--is-ancestor", tip.value, ws.config.main).ok) return;
  git(ws.primary, "update-ref", "-d", `refs/heads/${branch}`, tip.value);
}

/** Why `clean` must keep a worktree, cheapest check first; undefined when only the process check remains. */
export function keepReason(ws: Workspace, w: WorktreeInfo, held: ReadonlySet<string>): string | undefined {
  if (w.path === ws.root) return "you are in it";
  if (held.has(w.path)) return "claimed";
  const c = isClean(w.path);
  if (!c.ok || !c.value) return "uncommitted changes";
  const ahead = git(ws.primary, "rev-list", "--count", `${ws.config.main}..${w.head}`);
  if (!ahead.ok || ahead.value !== "0") return `${ahead.ok ? ahead.value : "?"} commit(s) not on ${ws.config.main}`;
  // `git status` and `git worktree remove` both ignore git-ignored files, so a `.env` would vanish silently.
  const ignored = ignoredPaths(w.path);
  if (!ignored.ok) return `cannot list ignored files (${ignored.error.message})`;
  // reason: canon's own generated files are always regenerable, whatever the project lists (BR-2176)
  const work = unregenerable(ignored.value, [...ws.config.regenerable, GENERATED_DIR]);
  if (work.length > 0) return `ignored files that cannot be regenerated: ${work.join(", ")} (if they can be, add their names to \`regenerable\` in canon/config.yaml)`;
  return undefined;
}

export function describeOccupants(list: readonly Occupant[]): string {
  return list.map((o) => `pid ${o.pid} (${o.command})`).join(", ");
}
