import { RE2JS } from "re2js";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Front-matter field declarations of a document type (BR-2619, D-159): the shape of each field's value, whether it may be
 * `none: <reason>`, and whether the session states it when the document is created (`due: create`). The shapes are
 * BR-2546's slot types; patterns run on RE2 (D-153), so no declared pattern can make a command hang.
 */
export type FieldShape = "text" | "id" | "ids" | "enum" | "pattern";
const SHAPES: readonly FieldShape[] = ["text", "id", "ids", "enum", "pattern"];

export interface FieldDeclaration {
  readonly name: string;
  readonly type: FieldShape;
  readonly values?: readonly string[];
  readonly pattern?: string;
  /** The value may also be `none: <reason>` with a non-empty reason. */
  readonly none: boolean;
  /** `create`: the command creating the document must be given it (BR-2620); undefined: optional. */
  readonly due?: "create";
  /** A built-in field canon's own reader checks with its own message, so the generic shape check skips it (BR-2623). */
  readonly own?: true;
}

const NAME = /^[a-z_][a-z0-9_]*$/;
const ID = /^[A-Z][A-Z0-9]*-\d+$/;
const NONE = /^none:\s*(\S.*)$/s;
const KEYS = new Set(["type", "values", "pattern", "none", "due"]);

/**
 * `types.<type>.fields` as declared: the old list of names (each a `text` field stated at creation, BR-2054) or a mapping
 * of name → declaration (BR-2619). `reserved` are the keys canon writes itself; `taken` are the fields a built-in type
 * already declares. A mistake is a config error naming the type, the field and why (BR-2045).
 */
export function parseFieldDeclarations(at: string, raw: unknown, reserved: ReadonlySet<string>, taken: ReadonlySet<string> = new Set()): Result<FieldDeclaration[]> {
  if (raw === undefined || raw === null) return ok([]);
  const named = (name: string): Result<void> => {
    if (!NAME.test(name)) return err("invalid", `\`${at}\`: field \`${name}\` must be lowercase letters, digits and _`);
    if (reserved.has(name)) return err("invalid", `\`${at}.${name}\`: \`${name}\` is a field canon owns`);
    if (taken.has(name)) return err("invalid", `\`${at}.${name}\`: the built-in type already declares \`${name}\` (BR-2623); a project may only add fields`);
    return ok(undefined);
  };
  if (Array.isArray(raw)) {
    const out: FieldDeclaration[] = [];
    for (const f of raw) {
      if (typeof f !== "string") return err("invalid", `\`${at}\` must be a list of lowercase field names or a mapping of field → declaration`);
      const n = named(f);
      if (!n.ok) return n;
      // reason: the old list form is a text field every new document must fill (BR-2054), which is what `due: create` says (BR-2619)
      out.push({ name: f, type: "text", none: false, due: "create" });
    }
    return ok(out);
  }
  if (typeof raw !== "object") return err("invalid", `\`${at}\` must be a list of lowercase field names or a mapping of field → declaration`);
  const out: FieldDeclaration[] = [];
  for (const [name, declRaw] of Object.entries(raw as Record<string, unknown>)) {
    const n = named(name);
    if (!n.ok) return n;
    const where = `${at}.${name}`;
    if (typeof declRaw !== "object" || declRaw === null || Array.isArray(declRaw)) return err("invalid", `\`${where}\` must be a mapping with \`type\``);
    const d = declRaw as Record<string, unknown>;
    for (const k of Object.keys(d)) if (!KEYS.has(k)) return err("invalid", `unknown key \`${where}.${k}\` (known: ${[...KEYS].join(", ")})`);
    const type = d["type"];
    if (typeof type !== "string" || !SHAPES.includes(type as FieldShape)) return err("invalid", `\`${where}.type\` must be one of ${SHAPES.join(", ")}`);
    const values = d["values"];
    if (type === "enum" && (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string" || v === ""))) return err("invalid", `\`${where}\`: an enum needs \`values\`, a non-empty list of strings`);
    const pattern = d["pattern"];
    if (type === "pattern") {
      if (typeof pattern !== "string") return err("invalid", `\`${where}\`: a pattern field needs \`pattern\``);
      try { RE2JS.compile(pattern); } catch (e) { return err("invalid", `\`${where}.pattern\`: ${JSON.stringify(pattern)} is not a valid regular expression in RE2 syntax (${(e as Error).message})`); }
    }
    const none = d["none"] ?? false;
    if (typeof none !== "boolean") return err("invalid", `\`${where}.none\` must be true or false`);
    const due = d["due"];
    if (due !== undefined && due !== "create") return err("invalid", `\`${where}.due\` can only be create`);
    out.push({ name, type: type as FieldShape, ...(type === "enum" ? { values: values as string[] } : {}), ...(type === "pattern" ? { pattern: pattern as string } : {}), none, ...(due === "create" ? { due: "create" as const } : {}) });
  }
  return ok(out);
}

/** The allowed shape, said in a message (BR-2620, BR-2622). */
export function shapeText(f: FieldDeclaration): string {
  const base =
    f.type === "text" ? "a non-empty text"
      : f.type === "id" ? "one document id such as BR-12"
        : f.type === "ids" ? "a list of document ids such as [BR-12, D-3]"
          : f.type === "enum" ? `one of ${f.values!.join(", ")}`
            : `a text matching ${f.pattern}`;
  return f.none ? `${base}, or "none: <reason>"` : base;
}

/** Why `value` does not fit the declaration of `f`, or undefined when it fits (BR-2622). */
export function fieldProblem(f: FieldDeclaration, value: unknown): string | undefined {
  const bad = `\`${f.name}\` is ${JSON.stringify(value)}, not ${shapeText(f)}`;
  if (f.none && typeof value === "string" && value.trim().startsWith("none:")) return NONE.test(value.trim()) ? undefined : `\`${f.name}\`: "none:" needs a reason after it`;
  switch (f.type) {
    case "text": return typeof value === "string" && value.trim() !== "" ? undefined : bad;
    case "id": return typeof value === "string" && ID.test(value.trim()) ? undefined : bad;
    case "ids": return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && ID.test(v.trim())) ? undefined : bad;
    case "enum": return typeof value === "string" && f.values!.includes(value.trim()) ? undefined : bad;
    case "pattern": return typeof value === "string" && RE2JS.compile(f.pattern!).matcher(value).matches() ? undefined : bad;
  }
}

/** A value given on the command line, as it is written: an `ids` field splits on , ， or 、 unless it is `none: …` (BR-2620, BR-2621). */
export function cliValue(f: FieldDeclaration, raw: string): unknown {
  const text = raw.trim();
  if (f.type === "ids" && !(f.none && text.startsWith("none:"))) return text.split(/[,，、]/).map((s) => s.trim()).filter((s) => s !== "");
  return text;
}
