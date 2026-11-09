import type { Corpus } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { PLAN_SECTION, readPlan } from "./parse.ts";

/**
 * Why a change cannot do `plan`'s steps on main's corpus, or undefined when it can: the plan's change exists on main
 * with a valid plan and every step is one of its steps. Shared by `canon work start --plan --step` (BR-2376) and
 * `canon plan link` (BR-2389).
 */
export function planProblem(corpus: Corpus, main: string, plan: { id: string; steps: readonly string[] }): string | undefined {
  const doc = findDoc(corpus, plan.id);
  if (!doc || doc.kind !== "change") return `${plan.id} is not a change on ${main}; --plan names the change that holds the plan`;
  const read = readPlan(doc.body);
  if (read.kind !== "plan") return `${plan.id} has no valid ${PLAN_SECTION} on ${main}${read.kind === "invalid" ? `: ${read.problem}` : ""}`;
  const unknown = plan.steps.filter((s) => !read.steps.some((p) => p.name === s));
  return unknown.length > 0 ? `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not a step of the plan in ${plan.id} (steps: ${read.steps.map((p) => p.name).join(", ")})` : undefined;
}
