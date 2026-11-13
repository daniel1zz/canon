import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import { changeIdsOnBranches, architectureBase, listedBefore } from "../../work/session/inflight.ts";
import { reportsFor } from "../../work/verify/changes.ts";
import { testFilesFor } from "../check/tests.ts";
import { check } from "../check/check.ts";
import type { ReadResult } from "../documents/read.ts";
import { linksOf } from "../links/start.ts";
import { redMain, fixLandedIn } from "../../work/watch/redmain.ts";
import { GREEN_REF, liveWatcher, tested, timingOnMain, watch } from "../../work/watch/watch.ts";

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

/** Every review row in (base..commit] not done, and every doc-touching commit in the range without a row (BR-2462). */
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
  const rows = ws.db.db.query<{ id: number; change: string | null; head: string; state: string }, []>("SELECT id, change, head, state FROM landed_reviews").all();
  const covered = new Set<string>();
  for (const r of rows) {
    if (!inRange(r.head)) continue;
    // reason: a later done review of the same head covers an earlier failed one (canon work review-landed --again writes a new row)
    if (r.state === "done") covered.add(r.head);
  }
  for (const r of rows) {
    if (!inRange(r.head) || covered.has(r.head)) continue;
    if (r.state === "failed") reasons.push(`the review after the landing of ${r.change ?? r.head.slice(0, 9)} failed: canon work review-landed --again ${r.change ?? "<C-n>"}`);
    else if (r.state === "queued" || r.state === "running") waiting.push(`the review after the landing of ${r.change ?? r.head.slice(0, 9)} is still ${r.state}`);
    covered.add(r.head);
  }
  const listed = git(ws.root, "rev-list", `${base}..${commit}`, "--", "canon/rules", "canon/decisions", "canon/releases");
  if (!listed.ok) return listed;
  for (const sha of listed.value.split("\n").filter((s) => s !== "")) {
    if (covered.has(sha)) continue;
    if (rows.some((r) => r.head === sha)) continue;
    reasons.push(`${sha.slice(0, 9)} changed canon/rules, canon/decisions or canon/releases but no review after its landing is recorded (landed without a \`review\` command? see review.skip): canon work review-landed --again <C-n>`);
  }
  return ok({ reasons, waiting });
}

export async function accept(ws: Workspace, say: Say, corpusRead: ReadResult): Promise<Result<AcceptOutcome>> {
  const commit = git(ws.root, "rev-parse", "--verify", `refs/heads/${ws.config.main}^{commit}`);
  if (!commit.ok) return err("io", `cannot resolve ${ws.config.main}: ${commit.error.message}`);
  const head = git(ws.root, "rev-parse", "HEAD");
  if (!head.ok) return head;
  if (head.value !== commit.value) return err("io", `acceptance reads the checkout: check out ${ws.config.main}'s latest commit ${commit.value.slice(0, 9)} first (HEAD is ${head.value.slice(0, 9)})`);
  const dirty = git(ws.root, "status", "--porcelain");
  if (!dirty.ok) return dirty;
  if (dirty.value.trim() !== "") return err("io", `acceptance reads the checkout: commit or stash the uncommitted changes first:\n${dirty.value.slice(0, 500)}`);

  const reasons: string[] = [];
  const waiting: string[] = [];
  const input = corpusInput(ws, corpusRead);
  if (!input.ok) return input;
  const findings = check(input.value);
  if (findings.length > 0) reasons.push(`canon check finds ${findings.length} problem(s): run canon check`);

  const open = ws.db.db.query<FindingRow, []>("SELECT id, text, question FROM review_findings WHERE closed_at IS NULL ORDER BY id").all();
  const verdicts: { finding: number; question: number; text: string }[] = [];
  const plain: number[] = [];
  for (const f of open) {
    const unanswered = f.question !== null && ws.db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(f.question)?.answer === null;
    if (unanswered) verdicts.push({ finding: f.id, question: f.question!, text: f.text });
    else plain.push(f.id);
  }
  if (plain.length > 0) reasons.push(`${plain.length} open review finding(s) (${plain.map((n) => `#${n}`).join(", ")}): settle each with canon finding close`);
  if (verdicts.length > 0) reasons.push(`${verdicts.length} finding(s) awaiting the owner's verdict (listed below)`);

  const links = linksOf(ws.root, corpusRead.corpus, ws.config.linksSince);
  if (!links.ok) return links;
  const suspects = links.value.filter((l) => l.suspect).length;
  if (suspects > 0) reasons.push(`${suspects} suspect reference(s): canon links list`);

  const reviews = reviewReasons(ws, reviewBase(ws), commit.value);
  if (!reviews.ok) return reviews;
  reasons.push(...reviews.value.reasons);
  waiting.push(...reviews.value.waiting);

  if (reasons.length === 0 && timingOnMain(ws) === "after" && !tested(ws.db, commit.value)) {
    const red = redMain(ws.db);
    if (red && !fixLandedIn(ws, red.sha)) reasons.push(`main has an unfixed floor failure at ${red.sha.slice(0, 9)} (log: ${red.log})`);
    else if (liveWatcher(ws.db)) waiting.push(`the background floor is testing main; run canon accept again when it finishes (canon work status shows it)`);
    else {
      say(`accept: ${commit.value.slice(0, 9)} is untested; running the floor now (BR-2462)`);
      const ran = await watch(ws, say, { now: true });
      if (!ran.ok) return ran;
      if (!tested(ws.db, commit.value)) reasons.push(`the floor did not pass on ${commit.value.slice(0, 9)}: see canon work status`);
    }
  }

  if (reasons.length > 0 || waiting.length > 0) return ok({ commit: commit.value, verdicts, reasons, waiting });

  const before = git(ws.root, "rev-parse", "--verify", "--quiet", `${ACCEPTED_REF}^{commit}`);
  const old = before.ok && before.value !== "" ? before.value : undefined;
  if (old !== undefined && old !== commit.value && !git(ws.root, "merge-base", "--is-ancestor", old, commit.value).ok)
    return ok({ commit: commit.value, verdicts, reasons: [`${ACCEPTED_REF} is at ${old.slice(0, 9)}, which is not an ancestor of ${commit.value.slice(0, 9)}; acceptance only moves forward`], waiting });
  if (old !== commit.value) {
    const moved = old === undefined ? git(ws.root, "update-ref", ACCEPTED_REF, commit.value, "0000000000000000000000000000000000000000") : git(ws.root, "update-ref", ACCEPTED_REF, commit.value, old);
    if (!moved.ok) {
      // reason: a concurrent acceptance may have moved it first; the same commit is still a success (BR-2462)
      const now = git(ws.root, "rev-parse", "--verify", "--quiet", `${ACCEPTED_REF}^{commit}`);
      if (!(now.ok && now.value === commit.value)) return err("conflict", `another acceptance moved ${ACCEPTED_REF} while this one ran: ${moved.error.message}`);
    }
  }
  ws.db.event(ws.actor, "accept.ok", null, { commit: commit.value });
  return ok({ commit: commit.value, verdicts, reasons, waiting });
}
