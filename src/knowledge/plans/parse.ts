import { STEP_NAME } from "../documents/planlink.ts";
import { withoutFences } from "../documents/model.ts";
import { section } from "../documents/templates.ts";

/** A plan in a change file (D-77): the table under `## 计划`, read by the one format BR-2369 states, never guessed from prose. */
export const PLAN_SECTION = "## 计划";

export interface Step {
  readonly name: string;
  readonly content: string;
  readonly dependsOn: readonly string[];
}

/** `none`: the body has no plan section; `invalid`: it has one that breaks BR-2369 or BR-2370, with what is wrong. */
export type PlanRead = { readonly kind: "none" } | { readonly kind: "plan"; readonly steps: readonly Step[] } | { readonly kind: "invalid"; readonly problem: string };

const COLUMNS = ["步骤", "内容", "依赖"] as const;
const NO_DEPENDENCY = new Set(["", "-", "无"]);

const cellsOf = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
};

/** The plan in a change body (BR-2369), or why the plan section cannot be read (BR-2370). */
export function readPlan(body: string): PlanRead {
  // reason: a table inside a code fence is an example of a plan, not a plan (BR-2369)
  const text = section(withoutFences(body), PLAN_SECTION);
  if (text === undefined) return { kind: "none" };
  const bad = (problem: string): PlanRead => ({ kind: "invalid", problem });
  const tables: string[][] = [];
  let open = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("|")) {
      if (!open) tables.push([]);
      tables[tables.length - 1]!.push(line);
      open = true;
    } else open = false;
  }
  if (tables.length === 0) return bad(`${PLAN_SECTION} has no table: the plan is a table with the columns ${COLUMNS.join(", ")}`);
  if (tables.length > 1) return bad(`${PLAN_SECTION} has ${tables.length} tables: the plan is one table`);
  const [head, rule, ...rows] = tables[0]!;
  const header = cellsOf(head!);
  for (const c of COLUMNS) {
    const n = header.filter((h) => h === c).length;
    if (n === 0) return bad(`the plan table has no ${c} column`);
    if (n > 1) return bad(`the plan table has the ${c} column twice`);
  }
  if (rule === undefined || !cellsOf(rule).every((c) => /^:?-+:?$/.test(c)) || cellsOf(rule).length !== header.length) return bad("the plan table's second line must be the separator row (| --- | --- | --- |)");
  if (rows.length === 0) return bad("the plan table has no steps");
  const at = (c: string) => header.indexOf(c);
  const steps: { name: string; content: string; deps: string; line: number }[] = [];
  for (const [i, row] of rows.entries()) {
    const cells = cellsOf(row);
    const n = i + 1;
    if (cells.length !== header.length) return bad(`step row ${n} has ${cells.length} cells, the header has ${header.length}`);
    const name = cells[at("步骤")]!;
    if (!STEP_NAME.test(name)) return bad(`step row ${n}: ${JSON.stringify(name)} is not a step name: letters and digits joined with . or -`);
    const content = cells[at("内容")]!;
    if (content === "") return bad(`step ${name} has no 内容`);
    steps.push({ name, content, deps: cells[at("依赖")]!, line: n });
  }
  const names = new Set<string>();
  for (const s of steps) {
    if (names.has(s.name)) return bad(`step ${s.name} is written twice`);
    names.add(s.name);
  }
  const out: Step[] = [];
  for (const s of steps) {
    const deps = NO_DEPENDENCY.has(s.deps) ? [] : s.deps.split(/[,，、]/).map((d) => d.trim());
    for (const d of deps) {
      if (!STEP_NAME.test(d)) return bad(`step ${s.name}: ${JSON.stringify(d)} in 依赖 is not a step name`);
      if (d === s.name) return bad(`step ${s.name} depends on itself`);
      if (!names.has(d)) return bad(`step ${s.name} depends on ${d}, which is not a step of this plan`);
    }
    out.push({ name: s.name, content: s.content, dependsOn: [...new Set(deps)] });
  }
  const cycle = findCycle(out);
  if (cycle) return bad(`steps ${cycle.join(" -> ")} depend on each other in a circle`);
  return { kind: "plan", steps: out };
}

/** The steps of one dependency circle, closing on the first, or undefined when there is none. */
function findCycle(steps: readonly Step[]): string[] | undefined {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | undefined => {
    if (state.get(name) === "done") return undefined;
    if (state.get(name) === "visiting") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "visiting");
    path.push(name);
    for (const d of byName.get(name)!.dependsOn) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(name, "done");
    return undefined;
  };
  for (const s of steps) {
    const found = visit(s.name);
    if (found) return found;
  }
  return undefined;
}
