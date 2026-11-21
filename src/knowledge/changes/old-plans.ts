import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocFile } from "../documents/docfile.ts";
import { withoutFences, type Change, type Corpus } from "../documents/model.ts";
import { section } from "../documents/templates.ts";

/**
 * Plans are gone (D-148): a change's `## 计划` table and the `plan`/`steps` other changes wrote are read only here, to
 * tell a project that has not moved its plans to changes yet how to do it (BR-2595). Nothing else reads them (BR-2594).
 */

const OLD_PLAN_SECTION = "## 计划";

const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The step names of the first table under `## 计划` whose header has 步骤 and 内容, in table order; none when there is no such table. */
export function oldPlanSteps(body: string): string[] {
  // reason: a heading or table inside a code fence is an example, not a plan (BR-2595)
  const text = section(withoutFences(body), OLD_PLAN_SECTION);
  if (text === undefined) return [];
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0) return [];
  const table: string[] = [];
  for (let i = start; i < lines.length && lines[i]!.trim().startsWith("|"); i++) table.push(lines[i]!);
  const header = cellsOf(table[0]!);
  const at = header.indexOf("步骤");
  if (at < 0 || !header.includes("内容")) return [];
  // reason: the second line is the separator row; every line after it is a step (BR-2595)
  return table.slice(2).map((row) => cellsOf(row)[at] ?? "").filter((name) => name !== "");
}

/** The `plan` and `steps` a change file wrote, as text; undefined when it wrote no usable pair. */
function oldLink(root: string, change: Change): { plan: string; steps: string[] } | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, change.path), "utf8");
  } catch {
    // reason: the corpus was just read from this file; one gone since is no landed step, and the note is only a hint (BR-2595)
    return undefined;
  }
  const parsed = parseDocFile(text, change.path);
  if (!parsed.ok) return undefined;
  const { plan, steps } = parsed.value.meta;
  if (typeof plan !== "string" || !Array.isArray(steps)) return undefined;
  // reason: YAML reads an unquoted 3 as a number; step names compare as text, so 3 and "3" are the same step (BR-2595)
  return { plan: plan.trim().toUpperCase(), steps: steps.filter((s) => typeof s === "string" || typeof s === "number").map(String) };
}

/** One note per change that is not dropped and has old plan steps no `done` change in this tree names (BR-2595). */
export function oldPlanNotes(root: string, corpus: Corpus): string[] {
  const changes = corpus.docs.filter((d): d is Change => d.kind === "change");
  const holders = changes.filter((c) => c.status !== "dropped").map((c) => ({ change: c, steps: oldPlanSteps(c.body) })).filter((h) => h.steps.length > 0);
  if (holders.length === 0) return [];
  const landed = changes.filter((c) => c.status === "done").map((c) => oldLink(root, c)).filter((l): l is { plan: string; steps: string[] } => l !== undefined);
  const out: string[] = [];
  for (const { change, steps } of holders) {
    const open = steps.filter((s) => !landed.some((l) => l.plan === change.id && l.steps.includes(s)));
    if (open.length === 0) continue;
    out.push(`note: ${change.path}: ${change.id} ${OLD_PLAN_SECTION} has step(s) no landed change names: ${open.join(", ")}; plans are gone (D-148): for each step still to do, run canon change new --title "<its 内容>" --owner-gate … --advances … --depends <the changes made for its 依赖 steps> (BR-2562), then delete its row; a step already done: delete its row too (BR-2595)`);
  }
  return out;
}
