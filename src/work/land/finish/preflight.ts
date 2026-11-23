import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../../workspace.ts";
import type { LandOutcome } from "../outcome.ts";
import { missingStatedFields, statedFieldsMessage } from "../checks/fields.ts";
import { approvalOf, gateRefusal } from "../owner-gate.ts";
import { isWorker } from "../../delegation/worker.ts";
import { isChore } from "../../session/subject.ts";
import { findDoc } from "../../../knowledge/query/query.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { duplicateHeadings, hasLessons, LESSONS_SECTION, linesSaid } from "../../../knowledge/documents/templates.ts";
import type { Finding } from "../../../knowledge/check/check.ts";
import { checkPolicyOf } from "../../../knowledge/check/config-keys.ts";
import { configAt } from "../../delegation/delegate.ts";

export type RefusalReason = Extract<LandOutcome, { kind: "refused" }>["reason"];
export interface Refusal {
  readonly reason: RefusalReason;
  readonly message: string;
}

/**
 * Every refusal the branch's content alone decides before the landing queues (BR-2634): the fields a document this
 * branch adds must state (BR-2624), and with `finish` the change's document, its lessons (BR-2161) and its owner_gate
 * approval (BR-2616). All of them, not the first, so one landing names everything to fix.
 */
export function contentRefusals(ws: Workspace, wt: string, main: string, subject: string | null, finish: boolean): { refusals: Refusal[]; notes: string[] } | { error: string } {
  const out: Refusal[] = [];
  const notes: string[] = [];
  const stated = missingStatedFields(wt, main, ws.config);
  if ("error" in stated) return stated;
  if (stated.lines.length > 0) out.push({ reason: "fields", message: statedFieldsMessage(stated.lines) });
  if (!finish || subject === null) return { refusals: out, notes };
  const doc = findDoc(readCorpus(wt, ws.config.types, ws.config).corpus, subject);
  if (!isChore(subject) && doc?.kind !== "change") {
    out.push({ reason: "check", message: `${subject}: its Change document is missing; this is not a chore` });
    return { refusals: out, notes };
  }
  if (doc?.kind !== "change" || doc.status !== "open") return { refusals: out, notes };
  const twice = duplicateHeadings(readFileSync(join(wt, doc.path), "utf8")).find((h) => h.heading === LESSONS_SECTION);
  if (twice) out.push({ reason: "lessons", message: `${subject}: ${LESSONS_SECTION} appears on lines ${linesSaid(twice.lines)} of ${doc.path}; canon reads only the first, so merge them into one section; commit, then land --finish again` });
  else if (!hasLessons(doc.body)) {
    // reason: whether an unfilled ## 教训 refuses is main's policies.checks.lessons, never the change's own (BR-2641, BR-2161)
    const policy = checkPolicyOf(configAt(ws, main), wt);
    if (!policy.ok) return { error: `canon/config.yaml on ${main}: ${policy.error.message}` };
    const message = `${subject} has no filled ${LESSONS_SECTION} section: write each lesson this work found and where it went (a mechanism's id, 只靠文字：<原因>, or 待负责人确认是否固化), or 无 when there is none; commit, then land --finish again`;
    if (policy.value.lessons === "refuse") out.push({ reason: "lessons", message });
    else if (policy.value.lessons === "remind") notes.push(`note: ${message} (policies.checks.lessons is remind, so the landing goes on)`);
  }
  if (doc.ownerGate !== undefined) {
    const approval = approvalOf(ws.db, subject, doc.ownerGate);
    if (!approval.approved) out.push({ reason: "owner-gate", message: gateRefusal(subject, doc.ownerGate, approval, isWorker(ws.actor)) });
  }
  return { refusals: out, notes };
}

/**
 * One message for several refusals, numbered; `findings` is what canon check finds on the branch before the rebase,
 * said as a note because the rebase onto main may still change it (BR-2634).
 */
export function refusalsMessage(refusals: readonly Refusal[], findings: readonly Finding[] = []): string {
  const head = refusals.length === 1 ? [refusals[0]!.message] : [`${refusals.length} things to fix before this landing can go on:`, ...refusals.map((r, i) => `${i + 1}. [${r.reason}] ${r.message}`)];
  const notes = findings.length === 0 ? [] : [`note: canon check on this branch, before the rebase onto main, also finds ${findings.length} finding(s); the landing checks them again after the rebase:`, ...findings.slice(0, 20).map((f) => `  ${f.path}: [${f.rule}] ${f.message}`), ...(findings.length > 20 ? [`  … and ${findings.length - 20} more (canon check)`] : [])];
  return [...head, ...notes].join("\n");
}
