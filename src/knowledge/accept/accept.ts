import { git } from "../../kernel/git.ts";
import { REVIEWED_DIRS } from "../../work/land/checks/review-scope.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import { changeIdsOnBranches, architectureBase, listedBefore } from "../../work/session/inflight.ts";
import { reportsFor } from "../../work/verify/changes.ts";
import { testFilesFor } from "../check/tests.ts";
import { check } from "../check/check.ts";
import type { ReadResult } from "../documents/read.ts";
import { linksOf } from "../links/start.ts";
import { reviewEntries } from "../../work/land/checks/review-scope.ts";
import { redMain, fixLandedIn } from "../../work/watch/redmain.ts";
import { liveWatcher, tested, timingOnMain, watch } from "../../work/watch/watch.ts";
import { corpusOf as corpusAtRef } from "../../work/session/session.ts";
import { fingerprintOf } from "../links/links.ts";
import type { Corpus, Decision, Rule } from "../documents/model.ts";

/**
 * `canon accept` (BR-2462, D-89, D-104): the owner's acceptance of main's current commit. Cheap conditions first, all
 * failures listed at once; the floor runs only when everything else holds and the commit is untested. On success the
 * commit is recorded in `refs/canon/accepted`, which the release (C-464 step H) ships.
 */
export const ACCEPTED_REF = "refs/canon/accepted";

export interface AcceptOutcome {
  readonly commit: string;
  /** Findings awaiting the owner's verdict (BR-2461), listed apart from plain open findings. */
  readonly verdicts: readonly { finding: number; question: number; text: string }[];
  readonly reasons: readonly string[];
  /** Conditions that are merely not finished yet: exit 75, not a refusal. */
  readonly waiting: readonly string[];
}

interface FindingRow {
  id: number;
  text: string;
  question: number | null;
}

/** The base the review-completeness range starts from (D-104). */
function reviewBase(ws: Workspace): string | undefined {
  const accepted = git(ws.root, "rev-parse", "--verify", "--quiet", `${ACCEPTED_REF}^{commit}`);
  if (accepted.ok && accepted.value !== "") return accepted.value;
  // reason: landings before the first landed_reviews row were reviewed inside the landing itself (pre-D-89), so they need no row (D-104)
  const first = ws.db.db.query<{ base: string }, []>("SELECT base FROM landed_reviews ORDER BY id LIMIT 1").get();
  return first?.base;
}

function corpusInput(ws: Workspace, read: ReadResult): Result<Parameters<typeof check>[0]> {
  const testFiles = testFilesFor(ws.root, ws.config);
  if (!testFiles.ok) return testFiles;
  const reports = reportsFor(ws.db, ws.root, ws.config, read.corpus, testFiles.value);
  if (!reports.ok) return reports;
  const branchChanges = changeIdsOnBranches(ws);
  if (!branchChanges.ok) return branchChanges;
  const backlogBase = listedBefore(ws);
  if (!backlogBase.ok) return backlogBase;
  const architecture = architectureBase(ws);
  if (!architecture.ok) return architecture;
  return ok({ root: ws.root, ...read, testFiles: testFiles.value, reports: reports.value, branchChanges: branchChanges.value, backlogBase: backlogBase.value, architecture: architecture.value });
}

/**
 * Every review row in (base..commit] not done, and every commit in the range with something to review that no row covers
 * (BR-2462). A row covers its whole landing, `base..head`: a landing can put several commits on main and the row names only
 * the last. A commit no row covers needs none when it changes nothing the review reads (only moves or `links` records, BR-2009).
 */
function reviewReasons(ws: Workspace, base: string | undefined, commit: string): Result<{ reasons: string[]; waiting: string[] }> {
  const reasons: string[] = [];
  const waiting: string[] = [];
  if (base === undefined) return ok({ reasons, waiting });
  const inRange = (sha: string): boolean => {
    if (sha === base) return false;
    const toCommit = git(ws.root, "merge-base", "--is-ancestor", sha, commit);
    if (!toCommit.ok) return false;
    return !git(ws.root, "merge-base", "--is-ancestor", sha, base).ok;
  };
  const rows = ws.db.db.query<{ id: number; change: string | null; base: string; head: string; state: string }, []>("SELECT id, change, base, head, state FROM landed_reviews ORDER BY id").all();
  const landing = (r: { base: string; head: string }): Result<string[]> => {
    const l = git(ws.root, "rev-list", `${r.base}..${r.head}`);
    return l.ok ? ok(l.value.split("\n").filter((s) => s !== "")) : l;
  };
  const done = new Set<string>();
  for (const r of rows) {
    if (!inRange(r.head)) continue;
    // reason: a later done review of the same head covers an earlier failed one (canon work review-landed --again writes a new row)
    if (r.state === "done") done.add(r.head);
  }
  const covered = new Set<string>();
  const said = new Set<string>();
  for (const r of rows) {
    if (!inRange(r.head)) continue;
    const shas = landing(r);
    if (!shas.ok) return shas;
    for (const s of shas.value) covered.add(s);
    if (done.has(r.head) || said.has(r.head)) continue;
    said.add(r.head);
    if (r.state === "failed") reasons.push(`the review after the landing of ${r.change ?? r.head.slice(0, 9)} failed: canon work review-landed --again ${r.change ?? "<C-n>"}`);
    else if (r.state === "queued" || r.state === "running") waiting.push(`the review after the landing of ${r.change ?? r.head.slice(0, 9)} is still ${r.state}`);
  }
  const listed = git(ws.root, "rev-list", `${base}..${commit}`, "--", ...REVIEWED_DIRS);
  if (!listed.ok) return listed;
  for (const sha of listed.value.split("\n").filter((s) => s !== "")) {
    if (covered.has(sha)) continue;
    const parent = git(ws.root, "rev-parse", "--verify", "--quiet", `${sha}^`);
    if (!parent.ok) return err("io", `cannot resolve the parent of ${sha.slice(0, 9)}: ${parent.error.message}`);
    if (reviewEntries(ws.root, parent.value, sha).entries.length === 0) continue;
    reasons.push(`${sha.slice(0, 9)} changed canon/rules, canon/decisions, canon/releases, canon/features or canon/quality but no review after its landing is recorded (landed without a \`review\` command? see review.skip): canon work review-landed --again <C-n>`);
  }
  return ok({ reasons, waiting });
}

/** The documents that are accepted one by one (BR-2537): active rules and accepted decisions. */
const acceptable = (corpus: Corpus): (Rule | Decision)[] =>
  corpus.docs.filter((d): d is Rule | Decision => (d.kind === "rule" && d.status === "active") || (d.kind === "decision" && d.status === "accepted"));

/** Whether `id` was accepted at this fingerprint (BR-2537). */
function acceptedAt(ws: Workspace, id: string, fp: string): boolean {
  return ws.db.db.query("SELECT 1 FROM events WHERE kind = 'doc.accept' AND subject = ? AND json_extract(detail, '$.fingerprint') = ? LIMIT 1").get(id, fp) !== null;
}

/** Why one document is not accepted on this commit: its open findings and its suspect references (BR-2537). */
interface DocDebt {
  readonly findings: readonly FindingRow[];
  readonly suspects: readonly string[];
}

function openFindings(ws: Workspace): (FindingRow & { docs: string[] })[] {
  return ws.db.db.query<FindingRow & { docs: string }, []>("SELECT id, text, question, docs FROM review_findings WHERE closed_at IS NULL ORDER BY id").all().map((f) => ({ ...f, docs: JSON.parse(f.docs) as string[] }));
}

/**
 * BR-2537 on `commit`, which passed the floor: every rule and decision not accepted at its current fingerprint is
 * accepted when it has no open finding and no suspect reference; `record` false only works out the debts (the floor has
 * not run yet). Returns the debts of those that are not accepted.
 */
export function acceptDocs(ws: Workspace, root: string, corpus: Corpus, commit: string, record: boolean, known?: { links: readonly { from: string; to: string; suspect: boolean }[]; findings: readonly (FindingRow & { docs: string[] })[] }): Result<Map<string, DocDebt>> {
  const links = known ? ok(known.links) : linksOf(root, corpus, ws.config.linksSince);
  if (!links.ok) return links;
  const findings = known?.findings ?? openFindings(ws);
  const debts = new Map<string, DocDebt>();
  for (const d of acceptable(corpus)) {
    const fp = fingerprintOf(d);
    if (acceptedAt(ws, d.id, fp)) continue;
    const debt = { findings: findings.filter((f) => f.docs.includes(d.id)), suspects: links.value.filter((l) => l.suspect && l.from === d.id).map((l) => l.to) };
    if (debt.findings.length === 0 && debt.suspects.length === 0) {
      if (record) ws.db.event(ws.actor, "doc.accept", d.id, { fingerprint: fp, commit });
    } else debts.set(d.id, debt);
  }
  return ok(debts);
}

/** The rules and decisions whose text changed since `base` (new, or another fingerprint), by id (BR-2462). */
function changedSince(ws: Workspace, base: string | undefined, corpus: Corpus): Result<Set<string>> {
  const now = acceptable(corpus);
  if (base === undefined) return ok(new Set(now.map((d) => d.id)));
  const before = corpusAtRef(ws, base);
  if (!before.ok) return before;
  const was = new Map(acceptable(before.value).map((d) => [d.id, fingerprintOf(d)]));
  return ok(new Set(now.filter((d) => was.get(d.id) !== fingerprintOf(d)).map((d) => d.id)));
}

const accepted = (ws: Workspace): string | undefined => {
  const r = git(ws.root, "rev-parse", "--verify", "--quiet", `${ACCEPTED_REF}^{commit}`);
  return r.ok && r.value !== "" ? r.value : undefined;
};

/**
 * The conditions of BR-2462 on `commit` in the tree at `ws.root`, except checking it out and running the floor: canon
 * check, the changed documents accepted (BR-2537; recorded when `tested`), the reviews complete. Shared by `canon accept`
 * and the background floor (BR-2538).
 */
async function conditions(ws: Workspace, read: ReadResult, commit: string, tested: boolean): Promise<Result<AcceptOutcome & { older: string | undefined }>> {
  const reasons: string[] = [];
  const waiting: string[] = [];
  const input = corpusInput(ws, read);
  if (!input.ok) return input;
  const findings = check(input.value);
  if (findings.length > 0) reasons.push(`canon check finds ${findings.length} problem(s): run canon check`);

  const point = accepted(ws) ?? reviewBase(ws);
  const changed = changedSince(ws, point, read.corpus);
  if (!changed.ok) return changed;
  const links = linksOf(ws.root, read.corpus, ws.config.linksSince);
  if (!links.ok) return links;
  const open = openFindings(ws);
  const debts = acceptDocs(ws, ws.root, read.corpus, commit, tested, { links: links.value, findings: open });
  if (!debts.ok) return debts;
  const verdicts: { finding: number; question: number; text: string }[] = [];
  const unanswered = (f: FindingRow) => f.question !== null && ws.db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(f.question)?.answer === null;
  for (const id of [...changed.value].sort()) {
    const debt = debts.value.get(id);
    if (!debt) continue;
    const plain = debt.findings.filter((f) => !unanswered(f));
    for (const f of debt.findings.filter(unanswered)) if (!verdicts.some((v) => v.finding === f.id)) verdicts.push({ finding: f.id, question: f.question!, text: f.text });
    const parts = [
      ...(plain.length > 0 ? [`open finding(s) ${plain.map((f) => `#${f.id}`).join(", ")} (canon finding close)`] : []),
      ...(debt.findings.length > plain.length ? [`finding(s) awaiting the owner's verdict (below)`] : []),
      ...(debt.suspects.length > 0 ? [`suspect reference(s) to ${debt.suspects.join(", ")} (canon links list)`] : []),
    ];
    reasons.push(`${id} changed since the last acceptance and is not accepted: ${parts.join("; ")}`);
  }
  // reason: an unchanged document's debts are listed whether or not it was accepted earlier; they only do not block (BR-2462)
  const oldFindings = open.filter((f) => f.docs.length > 0 && f.docs.every((d) => !changed.value.has(d))).length;
  const oldSuspects = links.value.filter((l) => l.suspect && !changed.value.has(l.from)).length;
  const older = oldFindings + oldSuspects > 0 ? `older debts (do not block): ${oldFindings} open finding(s), ${oldSuspects} suspect reference(s) on documents unchanged since ${point ? point.slice(0, 9) : "the start"}` : undefined;

  const reviews = reviewReasons(ws, reviewBase(ws), commit);
  if (!reviews.ok) return reviews;
  reasons.push(...reviews.value.reasons);
  waiting.push(...reviews.value.waiting);
  return ok({ commit, verdicts, reasons, waiting, older });
}

/** Moves refs/canon/accepted to `commit` by compare-and-swap, forward only, and records accept.ok (BR-2462). */
function moveAccepted(ws: Workspace, commit: string, detail: Record<string, unknown>): string | undefined {
  const old = accepted(ws);
  if (old !== undefined && old !== commit && !git(ws.root, "merge-base", "--is-ancestor", old, commit).ok) return `${ACCEPTED_REF} is at ${old.slice(0, 9)}, which is not an ancestor of ${commit.slice(0, 9)}; acceptance only moves forward`;
  if (old !== commit) {
    const moved = old === undefined ? git(ws.root, "update-ref", ACCEPTED_REF, commit, "0000000000000000000000000000000000000000") : git(ws.root, "update-ref", ACCEPTED_REF, commit, old);
    if (!moved.ok) {
      // reason: a concurrent acceptance may have moved it first; the same commit is still a success (BR-2462)
      const now = accepted(ws);
      if (now !== commit) return `another acceptance moved ${ACCEPTED_REF} while this one ran: ${moved.error.message}`;
    }
  }
  ws.db.event(ws.actor, "accept.ok", null, { commit, ...detail });
  return undefined;
}

export async function accept(ws: Workspace, say: Say, corpusRead: ReadResult): Promise<Result<AcceptOutcome & { older?: string }>> {
  const commit = git(ws.root, "rev-parse", "--verify", `refs/heads/${ws.config.main}^{commit}`);
  if (!commit.ok) return err("io", `cannot resolve ${ws.config.main}: ${commit.error.message}`);
  const head = git(ws.root, "rev-parse", "HEAD");
  if (!head.ok) return head;
  if (head.value !== commit.value) return err("io", `acceptance reads the checkout: check out ${ws.config.main}'s latest commit ${commit.value.slice(0, 9)} first (HEAD is ${head.value.slice(0, 9)})`);
  const dirty = git(ws.root, "status", "--porcelain");
  if (!dirty.ok) return dirty;
  if (dirty.value.trim() !== "") return err("io", `acceptance reads the checkout: commit or stash the uncommitted changes first:\n${dirty.value.slice(0, 500)}`);

  const after = timingOnMain(ws) === "after";
  const isTested = !after || tested(ws.db, commit.value);
  let c = await conditions(ws, corpusRead, commit.value, isTested);
  if (!c.ok) return c;
  const reasons = [...c.value.reasons];
  const waiting = [...c.value.waiting];
  if (reasons.length === 0 && waiting.length === 0 && !isTested) {
    const red = redMain(ws.db);
    if (red && !fixLandedIn(ws, red.sha)) reasons.push(`main has an unfixed floor failure at ${red.sha.slice(0, 9)} (log: ${red.log})`);
    else if (liveWatcher(ws.db)) waiting.push(`the background floor is testing main; run canon accept again when it finishes (canon work status shows it)`);
    else {
      say(`accept: ${commit.value.slice(0, 9)} is untested; running the floor now (BR-2462)`);
      const ran = await watch(ws, say, { now: true });
      if (!ran.ok) return ran;
      if (!tested(ws.db, commit.value)) reasons.push(`the floor did not pass on ${commit.value.slice(0, 9)}: see canon work status`);
      else {
        // reason: the documents are accepted only on a commit that passed the floor, so once more now that it has (BR-2537)
        c = await conditions(ws, corpusRead, commit.value, true);
        if (!c.ok) return c;
        reasons.push(...c.value.reasons);
        waiting.push(...c.value.waiting);
      }
    }
  }
  const out = { commit: commit.value, verdicts: c.value.verdicts, reasons, waiting, ...(c.value.older ? { older: c.value.older } : {}) };
  if (reasons.length > 0 || waiting.length > 0) return ok(out);
  const refused = moveAccepted(ws, commit.value, {});
  if (refused?.startsWith("another acceptance")) return err("conflict", refused);
  if (refused) return ok({ ...out, reasons: [refused] });
  return ok(out);
}

/**
 * BR-2538: after the background floor passed on `commit`, in its worktree `root`: accept the documents, then the commit
 * when every condition of BR-2462 but the checkout and the floor holds. Returns the line for the watch log.
 */
export async function acceptAfterFloor(ws: Workspace, root: string, commit: string, read: ReadResult): Promise<string> {
  const here = { ...ws, root };
  const c = await conditions(here, read, commit, true);
  if (!c.ok) return `accept: ${c.error.message}`;
  const open = c.value.reasons.length + c.value.waiting.length;
  if (open > 0) return `not accepted: ${open} condition(s); canon accept lists them`;
  const refused = moveAccepted(here, commit, { by: "floor watch" });
  return refused ? `not accepted: ${refused}` : `accepted ${commit}`;
}
