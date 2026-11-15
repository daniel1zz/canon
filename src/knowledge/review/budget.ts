import { createHash } from "node:crypto";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../../work/db.ts";
import { ask } from "../../work/humans/questions.ts";

interface ReviewPlan {
  readonly kind: "preview" | "land";
  readonly subject: string;
  readonly reviewer: string;
  readonly command: string;
  readonly maxCalls: number;
  readonly maxBytes: number;
  readonly prompts: readonly string[];
}

type Permission = { readonly allowed: true } | { readonly allowed: false; readonly message: string };
const APPROVE = "同意本次评审";
const DECLINE = "不运行本次评审";

/** Check the complete actual call plan, and atomically spend one exact owner approval (BR-2490, D-123). */
export function reviewBudget(db: CoordDb, actor: string, plan: ReviewPlan): Result<Permission> {
  const calls = plan.prompts.length;
  const bytes = plan.prompts.reduce((sum, p) => sum + Buffer.byteLength(p, "utf8"), 0);
  if (calls <= plan.maxCalls && bytes <= plan.maxBytes) return ok({ allowed: true });
  const digest = createHash("sha256");
  for (const part of [plan.kind, plan.subject, plan.reviewer, plan.command, String(plan.maxCalls), String(plan.maxBytes), ...plan.prompts]) {
    digest.update(`${Buffer.byteLength(part)}:`).update(part).update("\n");
  }
  const hash = digest.digest("hex");
  const detail = { hash, review: plan.kind, reviewer: plan.reviewer, calls, bytes, maxCalls: plan.maxCalls, maxBytes: plan.maxBytes };
  const question = `${plan.kind} 评审 ${plan.subject} 计划调用 ${calls} 次、总提示 ${bytes} 字节（${Math.ceil(bytes / 1024)} KB），超过本次预算。review_max_calls=${plan.maxCalls}，review_max_total_prompt_kb=${plan.maxBytes / 1024}。计划指纹 ${hash}。是否同意本次评审？`;
  try {
    // reason: checking the answer, consuming it or creating the next question shares one write lock (BR-2490).
    return db.db.transaction((): Result<Permission> => {
      const previous = db.db.query<{ id: number; answer: string | null }, [string]>(
        "SELECT q.id, q.answer FROM events e JOIN questions q ON q.id = json_extract(e.detail, '$.question') WHERE e.kind = 'review.budget.ask' AND json_extract(e.detail, '$.hash') = ? ORDER BY e.id DESC LIMIT 1",
      ).get(hash);
      const consumed = previous && db.db.query("SELECT 1 FROM events WHERE kind = 'review.budget.consume' AND json_extract(detail, '$.question') = ? LIMIT 1").get(previous.id);
      if (previous?.answer === APPROVE && !consumed) {
        db.event(actor, "review.budget.consume", plan.subject, { ...detail, question: previous.id });
        return ok({ allowed: true });
      }
      let id = previous?.id;
      if (!previous || consumed) {
        id = ask(db, actor, plan.subject, question, [APPROVE, DECLINE]);
        db.event(actor, "review.budget.ask", plan.subject, { ...detail, question: id });
      }
      const retry = plan.kind === "preview" ? "canon work review" : `canon work review-landed --again ${plan.subject}`;
      return ok({ allowed: false, message: `review budget: question #${id}: ${question} No reviewer was run. Ask the owner with this question and record their answer with canon human answer; after approval retry ${retry}.` });
    }).immediate();
  } catch (e) {
    return err("io", `the review budget question or approval could not be recorded: ${(e as Error).message}; no reviewer was run`);
  }
}
