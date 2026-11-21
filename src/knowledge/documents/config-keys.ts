import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseFieldDeclarations } from "./fields.ts";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, type JsonSchema, TUNABLE } from "../../invocation/key.ts";
import { templateFor } from "./templates.ts";
import { BUILTIN_TYPES, RESERVED_DIRS, RESERVED_FIELDS, type DocType } from "./types.ts";
import { parseItemDeclarations } from "./items/declaration.ts";

const TYPE_KEYS = new Set(["prefix", "dir", "statuses", "default", "fields", "sections", "items"]);

/**
 * A slot definition (BR-2546): the string `text`, `id` or `ids`, or a mapping with exactly one of the type keys and
 * an optional `required`. The schema cannot say that `enum` needs values or that `pattern` must compile; readTypes does.
 */
const SLOT_SCHEMA: JsonSchema = {
  anyOf: [
    { type: "string", enum: ["text", "id", "ids"] },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { const: true },
        id: { const: true },
        ids: { const: true },
        enum: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        pattern: { type: "string", minLength: 1 },
        required: { type: "boolean" },
      },
      anyOf: [{ required: ["text"] }, { required: ["id"] }, { required: ["ids"] }, { required: ["enum"] }, { required: ["pattern"] }],
    },
  ],
};

/** `format` and `slots`, the core of an item declaration and the whole of a children declaration (BR-2546). */
const TEMPLATE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "slots"],
  properties: {
    format: { type: "string" },
    slots: { type: "object", additionalProperties: SLOT_SCHEMA },
  },
};

/** One section's declaration (BR-2546); `items: null` means none, like an absent key. */
const ITEM_DECLARATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "slots"],
  properties: {
    format: { type: "string" },
    slots: { type: "object", additionalProperties: SLOT_SCHEMA },
    children: TEMPLATE_SCHEMA,
    on_mismatch: { enum: ["note", "finding"] },
    // The schema cannot say a string is a valid regular expression; readTypes refuses one that is not (BR-2546).
    none: { type: "string" },
  },
};

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
      // reason: the old list of names or a mapping of name → declaration (BR-2054, BR-2619); readTypes checks the rest
      fields: { type: ["array", "object", "null"] },
      sections: { type: "array", items: { type: "string", pattern: "^[^#\\n]*\\S[^#\\n]*$" } },
      items: { type: ["object", "null"], additionalProperties: ITEM_DECLARATION_SCHEMA },
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
    flow: {
      steps: ["test.check"],
      role: TUNABLE,
    },
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
    const builtinType = types.find((t) => t.builtin && t.name === name);
    const parsedFields = parseFieldDeclarations(`${at}.fields`, decl["fields"], RESERVED_FIELDS, new Set(builtinType?.fields.map((f) => f.name) ?? []));
    if (!parsedFields.ok) return parsedFields;
    const fields = parsedFields.value;

    const sectionsRaw = decl["sections"];
    if (sectionsRaw !== undefined && (!Array.isArray(sectionsRaw) || sectionsRaw.some((x) => typeof x !== "string" || x.trim() === "" || /[#\n]/.test(x)))) {
      return err("invalid", `\`${at}.sections\` must be a list of section titles (without \`##\`)`);
    }
    const items = parseItemDeclarations(`types.${name}.items`, decl["items"]);
    if (!items.ok) return items;
    const builtin = types.find((t) => t.builtin && t.name === name);
    if (builtin) {
      const reshaped = ["prefix", "dir", "statuses", "default"].find((k) => k in decl);
      if (reshaped) return err("invalid", `\`${at}.${reshaped}\`: built-in type ${name} can only declare \`fields\`, \`sections\` and \`items\``);
      if (name === "rule" && sectionsRaw !== undefined) return err("invalid", `\`${at}.sections\`: a rule's shape is fixed (\`## 规则\` and \`## 例子\`)`);
      // reason: a built-in declaration cannot be changed or deleted, only added to for sections it leaves undeclared (BR-2546, D-144)
      const redeclared = Object.keys(items.value).find((section) => builtin.items[section] !== undefined);
      if (redeclared !== undefined) {
        return err("invalid", `\`${at}.items.${redeclared}\`: the built-in ${name} type already declares its \`${redeclared}\` section (BR-2551), and a project may only declare sections it leaves undeclared (BR-2546)`);
      }
      types[types.indexOf(builtin)] = {
        ...builtin,
        fields: [...builtin.fields, ...fields],
        ...(sectionsRaw !== undefined ? { sections: sectionsRaw as string[] } : {}),
        items: { ...builtin.items, ...items.value },
      };
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
    types.push({ name, prefix, dir, statuses: list, defaultStatus: list ? ((dflt as string | undefined) ?? list[0]) : undefined, fields, sections: (sectionsRaw as string[] | undefined) ?? [], items: items.value, builtin: false });
  }
  return ok(types);
}

