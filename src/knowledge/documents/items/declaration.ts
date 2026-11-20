import { err, ok, type Result } from "../../../kernel/result.ts";
import type { ItemDeclaration, SlotType } from "./model.ts";
import { linearRegex } from "./read.ts";
import { parseTemplate, type TemplatePart } from "./template.ts";

/**
 * `types.<type>.items` (BR-2546): every section's declaration, checked when the config is read. A wrong declaration
 * is a config error, so every command fails with exit 2 through BR-2045; each message names the type, the section
 * and the reason.
 */

const SLOT_KINDS = ["text", "id", "ids", "enum", "pattern"] as const;
const SLOT_KEYS = new Set<string>([...SLOT_KINDS, "required"]);
const DECLARATION_KEYS = new Set(["format", "slots", "children", "on_mismatch", "none"]);
const CHILD_KEYS = new Set(["format", "slots"]);

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A template with its slot types, before `children` or `on_mismatch` is added: an item declaration's core. */
interface Template {
  readonly format: string;
  readonly slots: Readonly<Record<string, SlotType>>;
}

/** The value of `types.<type>.items`, where `where` is `types.<type>.items` (BR-2546). */
export function parseItemDeclarations(where: string, value: unknown): Result<Record<string, ItemDeclaration>> {
  if (value === undefined || value === null) return ok({});
  if (!isMapping(value)) return err("invalid", `\`${where}\` must be a mapping of section name → declaration`);
  const out: Record<string, ItemDeclaration> = {};
  for (const [section, raw] of Object.entries(value)) {
    const at = `${where}.${section}`;
    // reason: the key is the heading without `## `, so it must be a section title rather than a heading or a blank (BR-2546)
    if (section.trim() === "" || /\n|#/.test(section)) return err("invalid", `\`${at}\`: a section name is its heading without "## ", so it is not empty and holds no "#" or newline`);
    const parsed = parseDeclaration(at, raw);
    if (!parsed.ok) return parsed;
    out[section] = parsed.value;
  }
  return ok(out);
}

function parseDeclaration(at: string, raw: unknown): Result<ItemDeclaration> {
  if (!isMapping(raw)) return err("invalid", `\`${at}\` must be a mapping with format and slots, and optionally children and on_mismatch`);
  for (const key of Object.keys(raw)) {
    if (!DECLARATION_KEYS.has(key)) return err("invalid", `\`${at}.${key}\` is not part of an item declaration (known: ${[...DECLARATION_KEYS].join(", ")})`);
  }
  const template = parseTemplateAndSlots(at, raw);
  if (!template.ok) return template;
  const childrenRaw = raw["children"];
  let children: Template | undefined;
  if (childrenRaw !== undefined) {
    if (!isMapping(childrenRaw)) return err("invalid", `\`${at}.children\` must be a mapping with format and slots`);
    for (const key of Object.keys(childrenRaw)) {
      if (!CHILD_KEYS.has(key)) return err("invalid", `\`${at}.children.${key}\` is not part of a children declaration (known: format, slots)`);
    }
    const parsed = parseTemplateAndSlots(`${at}.children`, childrenRaw);
    if (!parsed.ok) return parsed;
    children = parsed.value;
  }
  const onMismatch = raw["on_mismatch"];
  if (onMismatch !== undefined && onMismatch !== "note" && onMismatch !== "finding") {
    return err("invalid", `\`${at}.on_mismatch\` must be \`note\` or \`finding\`, not ${JSON.stringify(onMismatch)}`);
  }
  const none = raw["none"];
  if (none !== undefined) {
    if (typeof none !== "string") return err("invalid", `\`${at}.none\` must be a regular expression written as a string`);
    const bad = regexProblem(none, false);
    if (bad !== undefined) return err("invalid", `\`${at}.none\`: ${bad}`);
  }
  return ok({
    format: template.value.format,
    slots: template.value.slots,
    ...(children !== undefined ? { children } : {}),
    ...(none !== undefined ? { none: none as string } : {}),
    // reason: a declaration that does not say how to treat a mismatch only notes it; refusing needs D-139 (BR-2546, BR-2549)
    onMismatch: onMismatch === "finding" ? "finding" : "note",
  });
}

/** `format` and `slots` together, since a template is only valid against its slot types. */
function parseTemplateAndSlots(at: string, raw: Record<string, unknown>): Result<Template> {
  const format = raw["format"];
  if (typeof format !== "string") return err("invalid", `\`${at}.format\` must be the template string`);
  const slotsRaw = raw["slots"];
  if (!isMapping(slotsRaw)) return err("invalid", `\`${at}.slots\` must be a mapping of slot name → type`);
  const slots: Record<string, SlotType> = {};
  for (const [name, def] of Object.entries(slotsRaw)) {
    const parsed = parseSlot(`${at}.slots.${name}`, def);
    if (!parsed.ok) return parsed;
    slots[name] = parsed.value;
  }
  const parsed = parseTemplate(format);
  if (!parsed.ok) return err("invalid", `\`${at}.format\`: ${parsed.error.message}`);
  const problems = validateTemplate(parsed.value, slots);
  if (problems.length > 0) return err("invalid", `\`${at}\`: ${problems.join("; ")}`);
  return ok({ format, slots });
}

/**
 * A slot's type (BR-2546): `text`, `id` or `ids` as a plain string; `enum` as `{ enum: [...], required?: true }`
 * and `pattern` as `{ pattern: "...", required?: true }`; `id` and `ids` can also be written as a mapping when they
 * are `required`.
 */
function parseSlot(at: string, def: unknown): Result<SlotType> {
  if (typeof def === "string") {
    if (def === "text") return ok({ kind: "text" });
    if (def === "id") return ok({ kind: "id" });
    if (def === "ids") return ok({ kind: "ids" });
    if (def === "enum") return err("invalid", `\`${at}\`: an enum slot needs its values, written \`{enum: [...]}\``);
    if (def === "pattern") return err("invalid", `\`${at}\`: a pattern slot needs its pattern, written \`{pattern: "..."}\``);
    return err("invalid", `\`${at}\`: unknown slot type ${JSON.stringify(def)} (text, id, ids, enum, pattern)`);
  }
  if (!isMapping(def)) return err("invalid", `\`${at}\` must be a slot type name or a mapping such as \`{pattern: "..."}\``);
  for (const key of Object.keys(def)) {
    if (!SLOT_KEYS.has(key)) return err("invalid", `\`${at}.${key}\` is not part of a slot definition (known: ${[...SLOT_KEYS].join(", ")})`);
  }
  const kinds = SLOT_KINDS.filter((k) => k in def);
  if (kinds.length !== 1) return err("invalid", `\`${at}\`: write exactly one of text, id, ids, enum, pattern`);
  return slotOf(`${at}`, kinds[0]!, def);
}

/** `at` already ends with the type key; the type's value carries its data. */
function slotOf(at: string, kind: (typeof SLOT_KINDS)[number], def: Record<string, unknown>): Result<SlotType> {
  const value = def[kind];
  const required = def["required"];
  // reason: `required` can be written on any metadata slot, and a text slot is prose that is always there (BR-2546)
  if (kind === "text" && required !== undefined) return err("invalid", `\`${at}.required\`: a text slot cannot be required`);
  if (kind !== "text" && required !== undefined && typeof required !== "boolean") {
    return err("invalid", `\`${at}.required\` must be true or false`);
  }
  const isRequired = required === true;
  if (kind === "text") {
    if (value !== true) return err("invalid", `\`${at}.text\` is written as \`text: true\` in a mapping, or as the string \`text\``);
    return ok({ kind: "text" });
  }
  if (kind === "enum") {
    if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      return err("invalid", `\`${at}.enum\` needs a non-empty list of values`);
    }
    return ok({ kind: "enum", values: value as string[], ...(isRequired ? { required: true } : {}) });
  }
  if (kind === "pattern") {
    if (typeof value !== "string" || value === "") return err("invalid", `\`${at}.pattern\` must be the regular expression a slot value matches`);
    const bad = regexProblem(value);
    if (bad !== undefined) return err("invalid", `\`${at}.pattern\`: ${bad}`);
    return ok({ kind: "pattern", pattern: value, ...(isRequired ? { required: true } : {}) });
  }
  if (value !== true) return err("invalid", `\`${at}.${kind}\` is written as \`${kind}: true\` in a mapping, or as the string \`${kind}\``);
  if (kind === "id") return ok({ kind: "id", ...(isRequired ? { required: true } : {}) });
  return ok({ kind: "ids", ...(isRequired ? { required: true } : {}) });
}

/**
 * Why a pattern cannot be used, with the pattern itself so the message names it (BR-2546): RE2JS cannot run it (D-153:
 * items are matched in linear time, so lookaround and backreferences are refused here rather than hanging a reader),
 * or it does not compile as one group inside a template.
 */
function regexProblem(pattern: string, embed = true): string | undefined {
  const shown = JSON.stringify(pattern);
  try {
    linearRegex(pattern);
  } catch (e) {
    return `${shown} is not a valid regular expression in RE2 syntax, which canon matches in linear time (${(e as Error).message})`;
  }
  if (!embed) return undefined;
  try {
    linearRegex(`(?<canonSlot>${pattern})`);
  } catch (e) {
    return `${shown} is not usable as a slot inside a template (${(e as Error).message})`;
  }
  return undefined;
}

/** Everything about a template and its slots that BR-2546 calls a config error, except nesting and closure (the parser's). */
function validateTemplate(parts: readonly TemplatePart[], slots: Readonly<Record<string, SlotType>>): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  const walk = (list: readonly TemplatePart[], inOptional: boolean): void => {
    for (const part of list) {
      if (part.kind === "literal") continue;
      if (part.kind === "optional") {
        walk(part.parts, true);
        continue;
      }
      if (used.has(part.name)) {
        problems.push(`slot \`${part.name}\` appears twice in the template`);
        continue;
      }
      used.add(part.name);
      const type = slots[part.name];
      if (type === undefined) {
        problems.push(`slot \`${part.name}\` is in the template but not in slots`);
        continue;
      }
      // reason: text is prose and must stay outside an optional part; every other type is metadata and lives in one (BR-2546)
      if (type.kind === "text" && inOptional) problems.push(`slot \`${part.name}\` is a text slot, so it must be outside an optional part`);
      if (type.kind !== "text" && !inOptional) problems.push(`slot \`${part.name}\` is a metadata slot, so it must be inside an optional part`);
    }
  };
  walk(parts, false);
  for (const name of Object.keys(slots)) {
    if (!used.has(name)) problems.push(`slot \`${name}\` is in slots but not in the template`);
  }
  // reason: two adjacent slots would make every split ambiguous, so literal text must separate them (BR-2546)
  let previous: string | undefined;
  let literalSince = false;
  const flat = (list: readonly TemplatePart[]): void => {
    for (const part of list) {
      if (part.kind === "literal") {
        if (part.text !== "") literalSince = true;
      } else if (part.kind === "optional") {
        flat(part.parts);
      } else {
        if (previous !== undefined && !literalSince) problems.push(`slots \`${previous}\` and \`${part.name}\` have no literal text between them`);
        previous = part.name;
        literalSince = false;
      }
    }
  };
  flat(parts);
  return problems;
}
