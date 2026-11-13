import { parseDocFile } from "../documents/docfile.ts";

/**
 * True when two texts of one document differ only in the front-matter `links` reference records (BR-2425): the body and
 * every other key parse to the same values, so a reformatted `amends: [D-9]` still counts as the same. Such an edit is
 * machine-written by `canon links confirm` or a landing, not an author changing the document (BR-2009, BR-2431, D-106).
 */
export function linksOnlyText(path: string, before: string, after: string): boolean {
  const a = parseDocFile(before, path);
  const b = parseDocFile(after, path);
  if (!a.ok || !b.ok || a.value.body.trimEnd() !== b.value.body.trimEnd()) return false;
  const rest = (x: Record<string, unknown>) => JSON.stringify(Object.entries(x).filter(([k]) => k !== "links").sort((l, r) => (l[0] < r[0] ? -1 : 1)));
  return rest(a.value.meta) === rest(b.value.meta);
}
