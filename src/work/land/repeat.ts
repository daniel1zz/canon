import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../db.ts";
import type { Workspace } from "../workspace.ts";
import { closeSubject } from "./finish/finish.ts";
import { changeIdsOnBranches } from "../session/inflight.ts";
import { readConfig } from "../../invocation/config.ts";
import { check, type Finding } from "../../knowledge/check/check.ts";
import { reportsFor } from "../verify/changes.ts";
import { backlogAt } from "../../knowledge/documents/backlog.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";

/**
 * A landing refused by canon check whose content and main have not changed since: canon check runs again before it
 * queues, so a refusal that still holds is said at once instead of after a turn in the queue (BR-2388, #154).
 */

// reason: only canon check is rerun: it is local and cheap, and what it reads beyond the tree (test reports, other
// branches) is read again now. A source check fetches pages, a review asks a model and a release check reads the
// owner's answers: any of them may come out differently on the same tree, so they queue as usual (BR-2388)
export const CONTENT_REASONS: readonly string[] = ["check"];

/** What a refusal records to be compared later: the tree of the change's own content and the main it was rebased onto. */
export interface RefusedAt {
  readonly tree: string;
  readonly main: string;
}

/** The tree of the branch's content without its close commit, as `reopen` leaves the branch after a refusal (BR-2018). */
export function contentTree(wt: string, subject: string | null): string | undefined {
  const top = git(wt, "log", "-1", "--format=%s");
  const closing = top.ok && subject !== null && top.value === closeSubject(subject);
  const tree = git(wt, "rev-parse", closing ? "HEAD~1^{tree}" : "HEAD^{tree}");
  return tree.ok ? tree.value : undefined;
}

/**
 * canon check on the worktree as it is, with what the landing gives it before the rebase-only steps: the test reports,
 * the changes on branches and main's backlog (BR-2388; the landing's own run is in checks/steps.ts). The findings, or
 * the error that kept it from running.
 */
export function checkNow(ws: Workspace, wt: string, main: string): { ok: true; findings: readonly Finding[] } | { ok: false; message: string } {
  const read = readCorpus(wt, ws.config.types, ws.config);
  const tests = testFilesFor(wt, ws.config);
  if (!tests.ok) return { ok: false, message: tests.error.message };
  const landing = readConfig(wt);
  if (!landing.ok) return { ok: false, message: landing.error.message };
  const onBranches = changeIdsOnBranches(ws);
  if (!onBranches.ok) return { ok: false, message: onBranches.error.message };
  const listed = backlogAt(wt, main, ws.config.types);
  if (!listed.ok) return { ok: false, message: listed.error.message };
  const reports = reportsFor(ws.db, wt, landing.value, read.corpus, tests.value);
  if (!reports.ok) return { ok: false, message: reports.error.message };
  const tip = git(wt, "rev-parse", main);
  if (!tip.ok) return { ok: false, message: tip.error.message };
  return { ok: true, findings: check({ root: wt, ...read, testFiles: tests.value, reports: reports.value, branchChanges: onBranches.value, backlogBase: new Set(listed.value.map((e) => e.id)), architecture: { refs: [tip.value], since: tip.value } }) };
}

export interface Repeat {
  readonly event: number;
  readonly at: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * The refusal this landing would repeat, or undefined: the change's latest landing event is a refusal for a content
 * reason that recorded the same content tree and the same main as now. Any later landing event (a landing, a kill,
 * another refusal) or a refusal that recorded no tree means it is not known, and the landing queues.
 */
export function repeatedRefusal(db: CoordDb, subject: string | null, now: RefusedAt): Repeat | undefined {
  if (subject === null) return undefined;
  const last = db.db
    .query<{ id: number; at: string; kind: string; detail: string }, [string]>("SELECT id, ts AS at, kind, detail FROM events WHERE subject = ? AND kind IN ('land.ok', 'land.refuse', 'land.killed', 'land.lost', 'land.interrupt') ORDER BY id DESC LIMIT 1")
    .get(subject);
  if (!last || last.kind !== "land.refuse") return undefined;
  const d = JSON.parse(last.detail) as { reason?: string; message?: string; tree?: string; main?: string; repeat_of?: number };
  if (!d.reason || !CONTENT_REASONS.includes(d.reason)) return undefined;
  if (d.tree !== now.tree || d.main !== now.main) return undefined;
  // reason: a repeat names the refusal it repeats, so a run of repeats all point to the first one (BR-2388)
  if (d.repeat_of !== undefined) {
    const first = db.db.query<{ at: string }, [number]>("SELECT ts AS at FROM events WHERE id = ?").get(d.repeat_of);
    return { event: d.repeat_of, at: first?.at ?? last.at, reason: d.reason, message: d.message ?? "" };
  }
  return { event: last.id, at: last.at, reason: d.reason, message: d.message ?? "" };
}
