import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { CoordDb } from "../../../work/db.ts";
import { reviewSettingsOn } from "../../../work/land/checks/review-scope.ts";
import { ask } from "../../../work/humans/questions.ts";
import { REVIEW_NONE } from "../config-keys.ts";
import { runJsonCommand } from "../review.ts";
import { pathOn } from "./close.ts";

/**
 * `canon finding reconcile` (BR-2461, D-103): two findings that pull the same documents in opposite directions go to the
 * review together, asking for one wording that satisfies both; when none exists, the command records a question for the
 * owner and links it to both findings, so acceptance (C-464 step G) finds the pair awaiting a verdict without parsing events.
 */
export type Reconciled =
  | { readonly kind: "not-opposed"; readonly reason: string }
  | { readonly kind: "wording"; readonly wording: string; readonly reason: string }
  | { readonly kind: "question"; readonly question: number; readonly reason: string };

export interface ReconcileInput {
  readonly cwd: string;
  readonly main: string;
  readonly actor: string;
  readonly a: string;
  readonly b: string;
}

interface Row {
  id: number;
  docs: string;
  text: string;
  criterion: string;
  change: string | null;
  question: number | null;
  closed_at: string | null;
  closed_how: string | null;
}

function parseId(raw: string): number | undefined {
  const s = raw.replace(/^#/, "");
  const n = Number(s);
  return /^\d+$/.test(s) && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function reconcilePrompt(rows: readonly Row[], docs: readonly { doc: string; text: string }[]): string {
  const finding = (r: Row) =>
    [`## Finding #${r.id} [${r.criterion}] (${r.closed_at === null ? "open" : `closed as ${r.closed_how}`})`, "", r.text].join("\n");
  return [
    "# Two review findings on the same documents",
    "",
    "Judge whether these two findings pull the same piece of text in opposite directions: one demands the wording the other blocks.",
    "If they do, give one wording that satisfies both findings at once. Work only from the findings and the documents below.",
    "",
    finding(rows[0]!),
    "",
    finding(rows[1]!),
    "",
    ...docs.flatMap((d) => [`# Document ${d.doc} (current text on main)`, "", d.text, ""]),
    "# Answer",
    "",
    "Print one JSON object and nothing else:",
    '- not opposite: {"opposed": false, "reason": "<why they are compatible>"}',
    '- opposite, a wording exists: {"opposed": true, "wording": "<the wording that satisfies both>", "reason": "<why it satisfies both>"}',
    '- opposite, no wording can satisfy both: {"opposed": true, "reason": "<why no wording can>"}',
  ].join("\n");
}

/** The checks of BR-2461 in its order, then one review call, then the event (and the question when nothing satisfies both). */
export async function reconcileFindings(db: CoordDb, input: ReconcileInput): Promise<Result<Reconciled>> {
  const a = parseId(input.a);
  const b = parseId(input.b);
  if (a === undefined || b === undefined) return err("invalid", `the finding numbers must be positive whole numbers, got ${JSON.stringify(input.a)} and ${JSON.stringify(input.b)}`);
  if (a === b) return err("invalid", `give two different findings, got #${a} twice`);
  const look = (n: number): Row | null => db.db.query<Row, [number]>("SELECT id, docs, text, criterion, change, question, closed_at, closed_how FROM review_findings WHERE id = ?").get(n);
  const rows = [look(a), look(b)];
  const missing = [a, b].filter((_, i) => rows[i] === null);
  if (missing.length > 0) return err("not_found", `review finding${missing.length > 1 ? "s" : ""} ${missing.map((n) => `#${n}`).join(", ")} ${missing.length > 1 ? "do" : "does"} not exist`);
  const [ra, rb] = rows as [Row, Row];
  const docsA = JSON.parse(ra.docs) as string[];
  const docsB = JSON.parse(rb.docs) as string[];
  if (!docsA.some((d) => docsB.includes(d))) return err("invalid", `#${a} (${docsA.join(", ")}) and #${b} (${docsB.join(", ")}) share no document; reconcile is for findings on the same documents`);
  for (const r of [ra, rb]) {
    if (r.question === null) continue;
    const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(r.question);
    if (q && q.answer === null) return err("conflict", `finding #${r.id} already awaits the owner's verdict: question #${r.question} is unanswered (canon human pending)`);
  }
  const settings = reviewSettingsOn(input.cwd, input.main);
  if (!settings.ok) return err("io", `cannot read main's review settings: ${settings.error.message}`);
  if (settings.value.review === undefined || settings.value.review === REVIEW_NONE) return err("io", "main's canon/config.yaml configures no `review` command; reconcile asks the review for a wording that satisfies both findings");
  const union = [...new Set([...docsA, ...docsB])].sort();
  const texts: { doc: string; text: string }[] = [];
  for (const doc of union) {
    const p = pathOn(input.cwd, input.main, doc);
    const text = p ? git(input.cwd, "show", `${input.main}:${p}`) : undefined;
    if (text?.ok === true) texts.push({ doc, text: text.value });
  }
  if (texts.length === 0) return err("io", `none of the documents #${a} and #${b} are attached to can be read on ${input.main}: ${union.join(", ")}`);
  const answer = await runJsonCommand(settings.value.review, input.cwd, reconcilePrompt([ra, rb], texts), { kind: "reconcile", timeoutMs: settings.value.reviewTimeoutMs });
  if (!answer.ok) return err("io", answer.error.message);
  const v = answer.value as { opposed?: unknown; wording?: unknown; reason?: unknown };
  if (typeof v.opposed !== "boolean") return err("io", `the review's answer has no boolean "opposed": ${JSON.stringify(answer.value).slice(0, 300)}`);
  const reason = typeof v.reason === "string" ? v.reason : "";
  const subject = (rb.id > ra.id ? rb : ra).change;
  if (!v.opposed) {
    db.event(input.actor, "finding.reconcile", subject, { findings: [a, b], opposed: false, reason });
    return ok({ kind: "not-opposed", reason });
  }
  const wording = typeof v.wording === "string" ? v.wording.trim() : "";
  if (wording !== "") {
    db.event(input.actor, "finding.reconcile", subject, { findings: [a, b], opposed: true, wording, reason });
    return ok({ kind: "wording", wording, reason });
  }
  const tx = db.db.transaction((): Result<Reconciled> => {
    // reason: the review call above takes minutes; only what CHANGED meanwhile is refused — a finding already closed at the start (the usual alternating pair) stays reconcilable (#202, 意见 #27, BR-2461)
    for (const r of [ra, rb]) {
      const now = db.db.query<{ question: number | null; closed_at: string | null }, [number]>("SELECT question, closed_at FROM review_findings WHERE id = ?").get(r.id);
      if (!now) return err("not_found", `review finding #${r.id} disappeared while the review ran`);
      if (now.closed_at !== r.closed_at) return err("conflict", `finding #${r.id} was closed while the review ran; nothing recorded`);
      if (now.question !== null && now.question !== r.question && db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(now.question)?.answer === null)
        return err("conflict", `finding #${r.id} already awaits the owner's verdict: question #${now.question} was recorded while the review ran`);
    }
    const question = ask(
      db,
      input.actor,
      subject,
      `评审意见 #${a} 和 #${b} 方向相反，评审给不出两边都满足的写法（${reason || "没有给出理由"}）。#${a}：${ra.text} #${b}：${rb.text} 按哪条意见的方向改，或者给出别的写法？`,
      [],
    );
    db.db.query("UPDATE review_findings SET question = ? WHERE id IN (?, ?)").run(question, a, b);
    db.event(input.actor, "finding.reconcile", subject, { findings: [a, b], opposed: true, question, reason });
    return ok({ kind: "question", question, reason });
  });
  return tx.immediate();
}

/** What `canon finding reconcile` prints (BR-2461). */
export function renderReconciled(a: number, b: number, r: Reconciled): string {
  if (r.kind === "not-opposed") return `findings #${a} and #${b} are not opposed: ${r.reason}`;
  if (r.kind === "wording") return `a wording satisfies both #${a} and #${b}:\n${r.wording}\nreason: ${r.reason}\napply it in a landing, then close both with canon finding close <n> --fixed <commit>`;
  return `no wording satisfies both #${a} and #${b} (${r.reason}); recorded question #${r.question} for the owner (canon human pending); the pair awaits the verdict`;
}
