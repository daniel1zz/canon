import type { Change, Corpus } from "../documents/model.ts";
import type { Finding } from "../check/check.ts";
import { PLAN_SECTION, readPlan } from "./parse.ts";

/**
 * The plan checks of `canon check` (D-77): a plan section follows BR-2369 and does not contradict itself (BR-2370), and a
 * change's `plan` and `steps` name a plan and steps that exist (BR-2371). The change and its rules are read either way.
 */
export function planFindings(corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change");
  for (const c of changes) {
    const own = readPlan(c.body);
    if (own.kind === "invalid") out.push({ path: c.path, rule: "file-invalid", message: `${c.id} ${PLAN_SECTION}: ${own.problem}` });
    if (c.plan === undefined) continue;
    const at = (message: string): Finding => ({ path: c.path, rule: "ref-dangling", message });
    const target = corpus.docs.find((d) => d.id === c.plan);
    if (target === undefined) out.push(at(`${c.id} \`plan\` names ${c.plan}, which does not exist`));
    else if (target.kind !== "change") out.push(at(`${c.id} \`plan\` names ${c.plan}, which is a ${target.kind}, not a change`));
    else {
      const plan = readPlan(target.body);
      // reason: a plan that does not read is reported once, at the plan (BR-2370), not again at every change that does a step of it
      if (plan.kind === "none") out.push(at(`${c.id} \`plan\` names ${c.plan}, which has no ${PLAN_SECTION} section`));
      if (plan.kind === "plan") {
        for (const s of c.steps ?? []) if (!plan.steps.some((p) => p.name === s)) out.push(at(`${c.id} \`steps\` names ${s}, which is not a step of the plan in ${c.plan}`));
      }
    }
  }
  return out;
}
