import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import { templateFor } from "../knowledge/documents/templates.ts";
import { BUILTIN_TYPES, RESERVED_DIRS, RESERVED_FIELDS, type DocType } from "../knowledge/documents/types.ts";
import { configKey, REL_DIR, relPath, type JsonSchema } from "./key.ts";
import { readPorts, type PortRange } from "./ports.ts";

export type HookEvent = "after_start" | "before_land" | "after_land" | "after_stop" | "after_green";
export const HOOK_EVENTS: readonly HookEvent[] = ["after_start", "before_land", "after_land", "after_stop", "after_green"];

/** A command: a string with something other than white space (readHooks rejects a blank one). */
const NON_BLANK: JsonSchema = { type: "string", pattern: "\\S" };

/** canon/config.yaml keys of the lifecycle hooks (D-2, D-3, C-135). */
export const hookKeys = {
  hooks: configKey<Readonly<Record<HookEvent, readonly string[]>>>({
    key: "hooks",
    doc: "Commands per lifecycle event, run in order; each event takes a command or a list of commands. after_green commands must be safe to run again: one can be cut off and is not rerun, the next pass runs them for a newer commit, possibly beside what the cut-off run left; act on CANON_GREEN and write files to a temporary name, then rename (BR-2222, D-55).",
    default: { after_start: [], before_land: [], after_land: [], after_stop: [], after_green: [] },
    schema: { type: ["object", "null"], additionalProperties: false, properties: Object.fromEntries(HOOK_EVENTS.map((e) => [e, { anyOf: [NON_BLANK, { type: "array", items: NON_BLANK }] }])), default: {} },
    read: readHooks,
    commands: (v) => Object.values(v).flat(),
    replaces: { after_land: "hooks.after_land" },
    listed: 70,
    checked: 170,
  }),
  ports: configKey<PortRange | undefined>({
    key: "ports",
    doc: "The range of ports, `<from>-<to>` such as 4100-4199, each change gets one of as CANON_PORT in setup and every hook; the same change keeps its port, two changes whose worktrees exist never share one, and a port something else listens on is skipped (BR-2267, BR-2288, D-41, D-48). Unset means no port.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: "^\\s*\\d+\\s*-\\s*\\d+\\s*$|^$" },
    read: readPorts,
    listed: 75,
    checked: 175,
  }),
};

function readHooks(v: unknown): Result<Record<HookEvent, readonly string[]>> {
  const out: Record<HookEvent, string[]> = { after_start: [], before_land: [], after_land: [], after_stop: [], after_green: [] };
  if (v === null) return ok(out);
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`hooks` must be a mapping of event → command or list of commands");
  for (const [event, cmds] of Object.entries(v as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) return err("invalid", `unknown hook event \`${event}\` (known: ${HOOK_EVENTS.join(", ")})`);
    const list = typeof cmds === "string" ? [cmds] : cmds;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || x.trim() === "")) return err("invalid", `\`hooks.${event}\` must be a command or a list of commands`);
    out[event as HookEvent] = list as string[];
  }
  return ok(out);
}

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

/** canon/config.yaml keys of document types and of where each domain's code lives (C-135). */
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
  codeRoot: configKey<string | undefined>({
    key: "code_root",
    doc: "The directory whose subdirectories mirror the rule domains one to one (`<codeRoot>/<domain path>`, D-15); unset means top-level domain READMEs list their code directories instead.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: REL_DIR.source },
    read: (v) => {
      if (v !== null && (typeof v !== "string" || !REL_DIR.test(v))) return err("invalid", "`code_root` must be a directory relative to the repository root, such as src");
      return ok(typeof v === "string" ? v : undefined);
    },
    listed: 150,
    checked: 110,
  }),
  // reason: shared reads code_root from ctx.raw, which is valid by now because code_root is checked first (BR-2116)
  shared: configKey<readonly string[]>({
    key: "shared",
    doc: "Directories (or files) under code_root that belong to no business domain, such as a shared kernel; empty without code_root (BR-2116).",
    default: [],
    schema: { type: ["array", "null"], items: relPath, default: [] },
    needs: ["code_root"],
    read: (v, ctx) => {
      if (v === null) return ok([]);
      const root = ctx.raw["code_root"];
      const codeRoot = typeof root === "string" ? root : undefined;
      if (codeRoot === undefined) return err("invalid", "`shared` needs `code_root`: it lists directories under the code root that are no domain's");
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !REL_DIR.test(s) || !s.startsWith(`${codeRoot}/`))) {
        return err("invalid", `\`shared\` must be a list of directories under ${codeRoot}, such as ${codeRoot}/kernel`);
      }
      return ok(v as string[]);
    },
    listed: 160,
    checked: 120,
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
    if (types.some((t) => t.prefix === prefix)) return err("invalid", `\`${at}.prefix\`: ${prefix} is already the prefix of another type`);
    if (typeof dir !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(dir)) return err("invalid", `\`${at}.dir\` must be a directory name under canon/`);
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

