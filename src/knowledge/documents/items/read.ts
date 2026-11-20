import { isPlaceholderLine, LESSONS_SECTION, LIST_MARKER } from "../templates.ts";
import type { ItemDeclaration, ReadItem, SlotType } from "./model.ts";
import { parseTemplate, type TemplatePart } from "./template.ts";

/**
 * Reads a section's items by its declaration (BR-2547): split the section into items, then match each item's text
 * against the template from start to end. An item the template does not fit is unknown, with the reason; canon
 * never guesses another spelling.
 */

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
const LESSONS_SECTION_NAME = LESSONS_SECTION.replace(/^## /, "");

/**
 * Reads one declared section (BR-2547). The built-in change type's `教训` is the one section whose declaration says
 * a lone `无…` line holds no lessons (BR-2551), so both `canon check` and `canon show --json` read it the same way.
 */
export function readSectionItems(typeName: string, section: string, text: string, declaration: ItemDeclaration): ReadItem[] {
  if (typeName === "change" && section === LESSONS_SECTION_NAME) {
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    // reason: BR-2551 defines the lone `无` (or `无：<why>`) line as no lesson at all, not as an item that lacks a destination
    if (lines.length === 1 && lines[0]!.startsWith("无")) return [];
  }
  return splitItems(text, declaration.children !== undefined).map((draft) => readDraft(draft, declaration));
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
  for (const line of lines) {
    if (LIST_MARKER.test(line)) {
      item = { parts: [line.replace(LIST_MARKER, "").trim()], children: [] };
      drafts.push(item);
      child = undefined;
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
      // reason: text before the first top-level list item is no item's; a blank line adds no space (BR-2547)
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
    let matched: RegExpExecArray | null = null;
    try {
      matched = new RegExp(`^${built.source}$`).exec(raw);
    } catch {
      // a pattern that cannot be embedded was refused when the declaration was read; a code-built one is canon's bug
      continue;
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
      return `[A-Z][A-Z0-9]*-[0-9]+(?:[,，、]\\s*[A-Z][A-Z0-9]*-[0-9]+)*`;
    case "enum":
      // reason: longest first, so a value that is a prefix of another does not win the alternation (BR-2546)
      return type.values.slice().sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
    case "pattern":
      return type.pattern;
  }
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason an item did not fit: the first literal the item lacks, or that it does not fit the template at all (BR-2547). */
function missingLiteral(raw: string, parts: readonly TemplatePart[]): string {
  for (const part of parts) {
    if (part.kind === "literal" && part.text !== "" && !raw.includes(part.text)) return `missing ${JSON.stringify(part.text)}`;
  }
  return "does not match the template";
}
