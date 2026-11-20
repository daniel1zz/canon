import { RE2JS } from "re2js";
import { isPlaceholderLine, LIST_MARKER } from "../templates.ts";
import type { ItemDeclaration, ReadItem, SlotType } from "./model.ts";
import { parseTemplate, type TemplatePart } from "./template.ts";

/**
 * Reads a section's items by its declaration (BR-2547): split the section into items, then match each item's text
 * against the template from start to end. An item the template does not fit is unknown, with the reason; canon
 * never guesses another spelling.
 *
 * reason: every regular expression here runs on RE2JS, which matches in time linear in the item's length, so no declared
 * `pattern` or `none` can hang a command that reads documents, and no match is given up after too many steps (BR-2547, D-153)
 */

/** Compiled expressions by source: the same declaration is matched against every item of every document. */
const compiled = new Map<string, RE2JS>();

/** Compiles an expression for the linear-time engine (D-153); throws RE2JS's syntax error for one it cannot run. */
export function linearRegex(source: string): RE2JS {
  let re = compiled.get(source);
  if (re === undefined) {
    re = RE2JS.compile(source);
    compiled.set(source, re);
  }
  return re;
}

interface Template {
  readonly format: string;
  readonly slots: Readonly<Record<string, SlotType>>;
}

/** An item's lines before matching: its text parts, and its indented sub-items when a children declaration reads them. */
interface Draft {
  readonly parts: readonly string[];
  readonly children: readonly Draft[];
}

/** A sub-item's list marker, with the indentation that makes it one (BR-2547). */
const CHILD_MARKER = /^\s+(?:[-*+]|\d+[.)])\s+/;
const INDENTED = /^\s/;

/**
 * Reads one declared section (BR-2547). When splitting gives exactly one item and the declaration's `none` regular
 * expression matches it, the section has no items: that is how a section says it holds nothing, such as a change's
 * lone `无` (BR-2551).
 */
export function readSectionItems(text: string, declaration: ItemDeclaration): ReadItem[] {
  const drafts = splitItems(text, declaration.children !== undefined);
  if (drafts.length === 1 && declaration.none !== undefined) {
    let none: RE2JS;
    try {
      none = linearRegex(declaration.none);
    } catch (e) {
      // reason: the config is checked when it is read (BR-2546), so only a declaration built in code reaches this
      throw new Error(`the declaration's none is not a valid regular expression: ${(e as Error).message}`);
    }
    if (none.test(rawOf(drafts[0]!))) return [];
  }
  return drafts.map((draft) => readDraft(draft, declaration));
}

/** An item's text without its list marker, its lines joined by one space (BR-2547). */
function rawOf(draft: Draft): string {
  return draft.parts.filter((part) => part !== "").join(" ");
}

/** Splits a section's text into items: top-level list items when there are any, otherwise one item per non-empty line (BR-2547). */
function splitItems(text: string, childrenDeclared: boolean): Draft[] {
  const lines = text.split("\n");
  if (!lines.some((line) => LIST_MARKER.test(line))) {
    const drafts: Draft[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || isPlaceholderLine(line)) continue;
      drafts.push({ parts: [trimmed], children: [] });
    }
    return drafts;
  }
  const drafts: Draft[] = [];
  let item: { parts: string[]; children: Draft[] } | undefined;
  let child: { parts: string[]; children: Draft[] } | undefined;
  // reason: before the first top-level list item a line is no item's continuation, so each non-empty line is an item of its
  // own, as in a section without list items; BR-2547's none example reads `无` and `- 另一条` as two items
  let leading = true;
  for (const line of lines) {
    if (LIST_MARKER.test(line)) {
      leading = false;
      item = { parts: [line.replace(LIST_MARKER, "").trim()], children: [] };
      drafts.push(item);
      child = undefined;
    } else if (leading) {
      const text = line.replace(CHILD_MARKER, "").trim();
      if (text === "") continue;
      drafts.push({ parts: [text], children: [] });
    } else if (CHILD_MARKER.test(line)) {
      if (item === undefined) continue;
      const sub = line.replace(CHILD_MARKER, "").trim();
      if (childrenDeclared) {
        child = { parts: [sub], children: [] };
        item.children.push(child);
      } else {
        // reason: an indented list item is a sub-item read on its own only with a children declaration; otherwise it joins the item (BR-2547)
        item.parts.push(sub);
      }
    } else {
      const trimmed = line.trim();
      if (trimmed === "" || item === undefined) continue;
      if (childrenDeclared && child !== undefined && INDENTED.test(line)) child.parts.push(trimmed);
      else item.parts.push(trimmed);
    }
  }
  // reason: a template placeholder line is no item (BR-2547, BR-2035), and neither is an item's placeholder first line
  return drafts
    .filter((draft) => !isPlaceholderLine(draft.parts[0] ?? ""))
    .map((draft) => ({ parts: draft.parts.filter((part) => part !== ""), children: draft.children.filter((c) => !isPlaceholderLine(c.parts[0] ?? "")) }));
}

function readDraft(draft: Draft, template: ItemDeclaration | Template): ReadItem {
  const raw = draft.parts.filter((part) => part !== "").join(" ");
  const match = matchItem(raw, template);
  let problem: string | undefined;
  let slots: Record<string, string> = {};
  if (match.kind === "unknown") problem = match.reason;
  else {
    slots = match.slots;
    const missing = Object.entries(template.slots)
      .filter(([name, type]) => (type as { readonly required?: boolean }).required === true && slots[name] === undefined)
      .map(([name]) => name);
    if (missing.length > 0) problem = `lacks ${missing.join(", ")}`;
  }
  const childTemplate = (template as { readonly children?: Template }).children;
  const children = childTemplate === undefined ? [] : draft.children.map((c) => readDraft(c, childTemplate));
  return { raw, slots, children, ...(problem !== undefined ? { problem } : {}) };
}

type Match = { readonly kind: "read"; readonly slots: Record<string, string> } | { readonly kind: "unknown"; readonly reason: string };

/** Matches one item's text against the template, choosing the match BR-2547's order asks for. */
function matchItem(raw: string, template: Template): Match {
  const parsed = parseTemplate(template.format);
  // reason: the config was checked when it was read, so this is only reachable for a declaration built in code
  if (!parsed.ok) return { kind: "unknown", reason: `the template is invalid (${parsed.error.message})` };
  const parts = parsed.value;
  const optionals = parts.filter((part) => part.kind === "optional").length;
  for (const mask of masksByPreference(optionals)) {
    const built = buildRegex(parts, mask, template.slots);
    let matched: { readonly groups?: Readonly<Record<string, string | undefined>> } | null = null;
    try {
      // reason: RE2JS's exec is typed any[]; it returns a RegExp-like array whose groups hold the named captures (BR-2547)
      matched = linearRegex(`^${built.source}$`).exec(raw) as { readonly groups?: Readonly<Record<string, string | undefined>> } | null;
    } catch (e) {
      // reason: a pattern that cannot be embedded was refused when the declaration was read, so reaching here is canon's own bug; fail loud instead of reading the item as unmatched (BR-2547)
      throw new Error(`canon bug: item pattern ${JSON.stringify(built.source)} did not compile: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (matched === null) continue;
    const slots: Record<string, string> = {};
    let fits = true;
    for (const [name, group] of built.groups) {
      const value = (matched.groups?.[group] ?? "").trim();
      // reason: a metadata value that does not fit its type counts as its optional part being absent (BR-2547)
      if (value === "") {
        fits = false;
        break;
      }
      slots[name] = value;
    }
    if (fits) return { kind: "read", slots };
  }
  return { kind: "unknown", reason: missingLiteral(raw, parts) };
}

/** Presence masks in BR-2547's order: most optional parts present first, then earlier optional parts present first. */
function masksByPreference(count: number): number[] {
  const masks = Array.from({ length: 1 << count }, (_, mask) => mask);
  const present = (mask: number): number => {
    let n = 0;
    for (let i = 0; i < count; i++) if ((mask & (1 << i)) !== 0) n++;
    return n;
  };
  return masks.sort((a, b) => {
    const countA = present(a);
    const countB = present(b);
    if (countA !== countB) return countB - countA;
    // reason: bit i is the i-th optional part in the template's order, so the one with the earlier part present wins (BR-2547)
    for (let i = 0; i < count; i++) {
      const inA = (a & (1 << i)) !== 0;
      const inB = (b & (1 << i)) !== 0;
      if (inA !== inB) return inA ? -1 : 1;
    }
    return 0;
  });
}

interface Built {
  readonly source: string;
  /** Slot name → the name of its capture group. */
  readonly groups: ReadonlyMap<string, string>;
}

/** The regular expression for one presence mask: each slot's group holds one value of its type, greedy so earlier slots take more. */
function buildRegex(parts: readonly TemplatePart[], mask: number, slotTypes: Readonly<Record<string, SlotType>>): Built {
  const groups = new Map<string, string>();
  let optional = 0;
  let group = 0;
  const emit = (list: readonly TemplatePart[]): string => {
    let out = "";
    for (const part of list) {
      if (part.kind === "literal") {
        out += escapeRegex(part.text);
      } else if (part.kind === "slot") {
        const type = slotTypes[part.name];
        // reason: every slot in a template is declared, so an absent one is a declaration checked nowhere
        if (type === undefined) throw new Error(`slot ${part.name} has no declared type`);
        const groupName = `s${group++}`;
        groups.set(part.name, groupName);
        out += `(?<${groupName}>${slotSource(type)})`;
      } else {
        const index = optional++;
        if ((mask & (1 << index)) !== 0) out += emit(part.parts);
      }
    }
    return out;
  };
  return { source: emit(parts), groups };
}

function slotSource(type: SlotType): string {
  switch (type.kind) {
    case "text":
      // reason: a text slot is non-empty prose, greedy so the slot before it takes as much as the rest of the template allows (BR-2547)
      return `[\\s\\S]+`;
    case "id":
      return `[A-Z][A-Z0-9]*-[0-9]+`;
    case "ids":
      return `[A-Z][A-Z0-9]*-[0-9]+(?:[,，、]${JS_SPACE}*[A-Z][A-Z0-9]*-[0-9]+)*`;
    case "enum":
      // reason: longest first, so a value that is a prefix of another does not win the alternation (BR-2546)
      return type.values.slice().sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
    case "pattern":
      return type.pattern;
  }
}

/**
 * JavaScript's `\s` in RE2 syntax: RE2's own `\s` is ASCII only, and an ids slot has always allowed any space after its
 * separator, a full-width one included (BR-2546).
 */
const JS_SPACE = `[\\s\\x{0B}\\p{Z}\\x{FEFF}]`;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason an item did not fit: the first literal the item lacks, or that it does not fit the template at all (BR-2547). */
function missingLiteral(raw: string, parts: readonly TemplatePart[]): string {
  for (const part of parts) {
    if (part.kind === "literal" && part.text !== "" && !raw.includes(part.text)) return `missing ${JSON.stringify(part.text)}`;
  }
  return "does not match the template";
}
