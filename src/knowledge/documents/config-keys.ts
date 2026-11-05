import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, type JsonSchema } from "../../invocation/key.ts";
import { templateFor } from "./templates.ts";
import { BUILTIN_TYPES, RESERVED_DIRS, RESERVED_FIELDS, type DocType } from "./types.ts";

const TYPE_KEYS = new Set(["prefix", "dir", "statuses", "default", "fields", "sections"]);

/**
 * What readTypes accepts, as far as JSON Schema can say it; prefix and dir uniqueness, which keys a built-in type may
 * set, and that a declared type needs prefix and dir are left to readTypes (BR-2175).
 */
const TYPES_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  propertyNames: { pattern: "^[a-z][a-z0-9-]*$" },
  additionalProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      prefix: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" },
      dir: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      statuses: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      default: { type: "string" },
      fields: { type: ["array", "null"], items: { type: "string", pattern: "^[a-z_][a-z0-9_]*$", not: { enum: [...RESERVED_FIELDS] } } },
      sections: { type: "array", items: { type: "string", pattern: "^[^#\\n]*\\S[^#\\n]*$" } },
    },
  },
};

/** canon/config.yaml key of the document types (C-135, D-63). */
export const documentKeys = {
  types: configKey<readonly DocType[]>({
    key: "types",
    doc: "Document types beyond the built-in ones, and the fields and sections of built-in ones (BR-2050); Config holds the built-in types followed by the declared ones.",
    default: BUILTIN_TYPES,
    schema: TYPES_SCHEMA,
    read: readTypes,
    listed: 80,
    checked: 180,
  }),
};

/**
 * Type name → template body from `canon/templates/<name>.md`; a template for an undeclared type, or a template (the
 * project's or the built-in one) without a required section of its type, is a config error (BR-2092).
 */
export function readTemplates(root: string, types: readonly DocType[]): Result<Record<string, string>> {
  const templates: Record<string, string> = {};
  const tdir = join(root, "canon", "templates");
  if (existsSync(tdir)) {
    for (const file of readdirSync(tdir).filter((f) => f.endsWith(".md"))) {
      const name = file.slice(0, -3);
      if (!types.some((t) => t.name === name)) return err("invalid", `canon/templates/${file} is a template for \`${name}\`, which is not a document type`);
      templates[name] = readFileSync(join(tdir, file), "utf8");
    }
  }
  // The template a new document starts from, the project's or the built-in one, carries every required section (BR-2092).
  for (const t of types) {
    const lines = templateFor(t.name, templates, t.sections).split("\n").map((l) => l.trim());
    const missing = t.sections.filter((s) => !lines.includes(`## ${s}`));
    if (!missing.length) continue;
    const where = t.name in templates ? `canon/templates/${t.name}.md` : `the built-in ${t.name} template (add canon/templates/${t.name}.md)`;
    return err("invalid", `${where} lacks required section(s) ${missing.map((s) => `\`## ${s}\``).join(", ")} of type \`${t.name}\``);
  }
  return ok(templates);
}

function readTypes(v: unknown): Result<DocType[]> {
  const types: DocType[] = BUILTIN_TYPES.map((t) => ({ ...t }));
  if (v === undefined || v === null) return ok(types);
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`types` must be a mapping of type name → declaration");
  for (const [name, declRaw] of Object.entries(v as Record<string, unknown>)) {
    const at = `types.${name}`;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return err("invalid", `\`${at}\`: a type name is lowercase letters, digits and dashes`);
    if (typeof declRaw !== "object" || declRaw === null || Array.isArray(declRaw)) return err("invalid", `\`${at}\` must be a mapping`);
    const decl = declRaw as Record<string, unknown>;
    for (const key of Object.keys(decl)) if (!TYPE_KEYS.has(key)) return err("invalid", `unknown key \`${at}.${key}\` (known: ${[...TYPE_KEYS].join(", ")})`);
    const fields = decl["fields"] ?? [];
    if (!Array.isArray(fields) || fields.some((f) => typeof f !== "string" || !/^[a-z_][a-z0-9_]*$/.test(f))) return err("invalid", `\`${at}.fields\` must be a list of lowercase field names`);
    const reserved = (fields as string[]).find((f) => RESERVED_FIELDS.has(f));
    if (reserved) return err("invalid", `\`${at}.fields\`: \`${reserved}\` is a field canon owns`);

    const sectionsRaw = decl["sections"];
    if (sectionsRaw !== undefined && (!Array.isArray(sectionsRaw) || sectionsRaw.some((x) => typeof x !== "string" || x.trim() === "" || /[#\n]/.test(x)))) {
      return err("invalid", `\`${at}.sections\` must be a list of section titles (without \`##\`)`);
    }
    const builtin = types.find((t) => t.builtin && t.name === name);
    if (builtin) {
      const reshaped = ["prefix", "dir", "statuses", "default"].find((k) => k in decl);
      if (reshaped) return err("invalid", `\`${at}.${reshaped}\`: built-in type ${name} can only declare \`fields\` and \`sections\``);
      if (name === "rule" && sectionsRaw !== undefined) return err("invalid", `\`${at}.sections\`: a rule's shape is fixed (\`## 规则\` and \`## 例子\`)`);
      types[types.indexOf(builtin)] = { ...builtin, fields: fields as string[], ...(sectionsRaw !== undefined ? { sections: sectionsRaw as string[] } : {}) };
      continue;
    }
    const prefix = decl["prefix"];
    const dir = decl["dir"];
    const statuses = decl["statuses"];
    const dflt = decl["default"];
    if (typeof prefix !== "string" || !/^[A-Z][A-Z0-9]*$/.test(prefix)) return err("invalid", `\`${at}.prefix\` must be uppercase letters and digits, e.g. SP`);
    // reason: the release type is built in (D-61), so a project that declared R or releases before upgrading needs to know to rename, not that "another type" has the prefix (BR-2045)
    const release = types.find((t) => t.builtin && t.name === "release");
    if (release && prefix === release.prefix) {
      return err("invalid", `\`${at}.prefix\`: ${prefix} is the prefix of canon's built-in release type (canon/${release.dir}/${release.prefix}-n.md, D-61), so no declared type can use it; to migrate, give \`${name}\` another prefix and rename its documents' ids (and every reference to them) to match`);
    }
    if (types.some((t) => t.prefix === prefix)) return err("invalid", `\`${at}.prefix\`: ${prefix} is already the prefix of another type`);
    if (typeof dir !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(dir)) return err("invalid", `\`${at}.dir\` must be a directory name under canon/`);
    if (release && dir === release.dir) {
      return err("invalid", `\`${at}.dir\`: canon/${dir} is the directory of canon's built-in release type (D-61), so no declared type can use it; to migrate, rename \`${name}\`'s directory (git mv canon/${dir} canon/<other>) and set \`${at}.dir\` to the new name`);
    }
    if (RESERVED_DIRS.has(dir) || types.some((t) => t.dir === dir)) return err("invalid", `\`${at}.dir\`: canon/${dir} is already used`);
    if (statuses !== undefined && (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((s) => typeof s !== "string" || s === ""))) {
      return err("invalid", `\`${at}.statuses\` must be a non-empty list of statuses`);
    }
    const list = statuses as string[] | undefined;
    if (dflt !== undefined && (list === undefined || typeof dflt !== "string" || !list.includes(dflt))) return err("invalid", `\`${at}.default\` must be one of \`${at}.statuses\``);
    types.push({ name, prefix, dir, statuses: list, defaultStatus: list ? ((dflt as string | undefined) ?? list[0]) : undefined, fields: fields as string[], sections: (sectionsRaw as string[] | undefined) ?? [], builtin: false });
  }
  return ok(types);
}

