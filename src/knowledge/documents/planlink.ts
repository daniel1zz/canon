/**
 * A change's link to the plan it does steps of (D-77): `plan: C-n` and `steps: [name, ...]` in its front matter,
 * the one connection between a step and the changes doing it. The shape is read here, for the corpus and for change
 * files read off a branch alike; whether the plan and the steps exist is `canon check`'s to say (BR-2371).
 */

/** A step name: letters and digits joined with `.` or `-`: `1`, `2a`, `3.1`, `db-1` (BR-2369). */
export const STEP_NAME = /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/;

export interface PlanLink {
  readonly plan?: string;
  readonly steps?: readonly string[];
}

/** The link in `meta`, `{}` when it has neither key, or the problem with it (BR-2371). */
export function planLink(meta: Record<string, unknown>, changePrefix: string): PlanLink | string {
  const plan = meta["plan"];
  const steps = meta["steps"];
  if (plan === undefined && steps === undefined) return {};
  if (plan === undefined || steps === undefined) return "`plan` and `steps` go together: a change names the plan it does steps of and which steps (D-77)";
  if (typeof plan !== "string" || !new RegExp(`^${changePrefix}-\\d+$`).test(plan)) return `\`plan\` must be a change id such as ${changePrefix}-1 (D-77)`;
  if (!Array.isArray(steps) || steps.length === 0) return "`steps` must be a non-empty list of step names (D-77)";
  const names: string[] = [];
  for (const s of steps) {
    // reason: YAML reads an unquoted 3 as a number and 3.10 as 3.1; only whole numbers keep their name, anything else is quoted (BR-2371)
    if (typeof s === "number" && Number.isInteger(s) && s >= 0) names.push(String(s));
    else if (typeof s === "string" && STEP_NAME.test(s)) names.push(s);
    else if (typeof s === "number") return `\`steps\` has ${s} as a number: a step name with a decimal point is quoted ("3.1"), since YAML reads 3.10 as 3.1 (D-77)`;
    else return `\`steps\` has ${JSON.stringify(s)}, which is not a step name: letters and digits joined with . or - (D-77)`;
  }
  return { plan, steps: names };
}
