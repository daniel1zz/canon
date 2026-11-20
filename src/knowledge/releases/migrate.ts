import { criteriaSection, criterionItems, type CriterionItem } from "./criteria.ts";

/**
 * `canon release migrate-criteria` (BR-2567, D-151): the old way counted every top-level list item of `## 成功标准` as a
 * criterion; now only numbered ones are. Each unnumbered item gets the next free `S<k>`, or, when named as a note, is
 * moved out of the list to the end of the section. Works on a document's whole text; nothing else in it changes.
 */

export interface MigrationStep {
  readonly item: CriterionItem;
  /** The id it gets, or `note` when it moves out of the list. */
  readonly to: string;
}

/** What migrating a document's text would do: one step per unnumbered item, in document order (BR-2567). */
export function migrationSteps(text: string, notes: ReadonlySet<number>): MigrationStep[] {
  const items = criterionItems(text);
  let next = Math.max(0, ...items.flatMap((i) => (i.id === undefined ? [] : [Number(i.id.slice(1))]))) + 1;
  return items.filter((i) => i.id === undefined).map((item) => ({ item, to: notes.has(item.position) ? "note" : `S${next++}` }));
}

const indented = (l: string) => /^[ \t]+\S/.test(l);

/** The index after the last line of the item starting at `at`: its indented sub-items and continuation lines, blank lines between them included. */
function blockEnd(lines: readonly string[], at: number, end: number): number {
  let last = at;
  for (let j = at + 1; j < end; j++) {
    if (indented(lines[j]!)) last = j;
    else if (lines[j]!.trim() !== "") break;
  }
  return last + 1;
}

/** The text after `steps`: numbered items get `S<k> ` after their marker; notes leave the list for the end of the section (BR-2567). */
export function migrated(text: string, steps: readonly MigrationStep[]): string {
  const lines = text.split("\n");
  const range = criteriaSection(lines)!;
  for (const s of steps) if (s.to !== "note") lines[s.item.line] = `${s.item.marker}${s.to} ${s.item.first}`;
  const notes = steps.filter((s) => s.to === "note").map((s) => ({ start: s.item.line, end: blockEnd(lines, s.item.line, range.end) }));
  const moved = notes.map((n) => [lines[n.start]!.slice(steps.find((s) => s.item.line === n.start)!.item.marker.length), ...lines.slice(n.start + 1, n.end)]);
  let end = range.end;
  for (const n of [...notes].reverse()) {
    lines.splice(n.start, n.end - n.start);
    end -= n.end - n.start;
  }
  if (moved.length > 0) {
    let at = end;
    while (at > range.start && lines[at - 1]!.trim() === "") at--;
    // reason: each note becomes a paragraph of its own after the list, so it is no longer a list item (BR-2567, BR-2504)
    lines.splice(at, 0, ...moved.flatMap((m) => ["", ...m]));
  }
  return lines.join("\n");
}
