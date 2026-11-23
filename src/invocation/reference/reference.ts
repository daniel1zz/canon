import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ensureExcluded } from "../../kernel/exclude.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { CONFIG_KEYS } from "../config.ts";
import { POLICIES, rawAt, type JsonSchema } from "../key.ts";

/**
 * What a project can set in canon/config.yaml, for people and editors (D-28): the list `canon config` prints
 * (BR-2174), the JSON Schema (BR-2175), and the generated, git-ignored copy of it editors read (BR-2176).
 */

/** Directory, at the root of every checkout, of files canon generates and never commits (BR-2176). */
export const GENERATED_DIR = ".canon";
export const SCHEMA_FILE = `${GENERATED_DIR}/config.schema.json`;
/** The comment canon/config.yaml starts with so yaml-language-server finds the schema (relative to the yaml file). */
export const MODELINE = `# yaml-language-server: $schema=../${SCHEMA_FILE}`;

/** Keys in the order an unknown key's error lists them, which is the order people read them in. */
const KEYS = [...CONFIG_KEYS].map(([, k]) => k).sort((a, b) => a.listed - b.listed);

export function configSchema(): JsonSchema {
  // reason: null means unset (BR-2116), so a key's needs apply only when it is not null, and are met only by values
  // that are not null; a plain property dependency would refuse `shared: null` that canon accepts (BR-2175, issue #62)
  const dependencies = Object.fromEntries(
    KEYS.filter((k) => k.needs?.length).map((k) => [
      k.key,
      { anyOf: [{ properties: { [k.key]: { type: "null" } } }, { required: [...k.needs!], properties: Object.fromEntries(k.needs!.map((n) => [n, { not: { type: "null" } }])) }] },
    ]),
  );
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "canon/config.yaml",
    description: "canon's project configuration. Changing it lands like any other change; `canon config` shows every key and its current value.",
    type: "object",
    additionalProperties: false,
    // reason: a dotted key lives under its group's parent mapping, as canon/config.yaml writes it (BR-2638)
    properties: {
      ...Object.fromEntries(KEYS.filter((k) => !k.key.includes(".")).map((k) => [k.key, { ...k.schema, description: k.doc }])),
      ...(KEYS.some((k) => k.key.startsWith(`${POLICIES}.`)) ? { [POLICIES]: { type: ["object", "null"], additionalProperties: false, description: "Policies a project sets, by group; each group is declared by the domain that uses it (BR-2638).", properties: Object.fromEntries(KEYS.filter((k) => k.key.startsWith(`${POLICIES}.`)).map((k) => [k.key.slice(POLICIES.length + 1), { ...k.schema, description: k.doc }])) } } : {}),
    },
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
  };
}

export const schemaText = () => `${JSON.stringify(configSchema(), null, 2)}\n`;

export interface KeyView {
  readonly key: string;
  /** Whether canon/config.yaml writes this key. */
  readonly set: boolean;
  /** As written in canon/config.yaml; null when not set. */
  readonly value: unknown;
  /** As canon/config.yaml would write it; null when the key has none. */
  readonly default: unknown;
  readonly doc: string;
}

/**
 * Every key with what canon/config.yaml in `root` writes for it. Called after the config was read successfully
 * (BR-2045), so the file, when it exists, is a valid mapping.
 */
export function viewConfig(root: string): KeyView[] {
  const path = join(root, "canon", "config.yaml");
  const raw = existsSync(path) ? ((parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>) : {};
  return KEYS.map((k) => {
    const at = rawAt(raw, k.key);
    return { key: k.key, set: at.set, value: at.set ? at.value : null, default: k.schema["default"] ?? null, doc: k.doc };
  });
}

export function renderConfig(root: string, views: readonly KeyView[]): string {
  const value = (v: KeyView) => (v.set ? JSON.stringify(v.value) : v.default === null ? "(unset)" : `${JSON.stringify(v.default)} (default)`);
  const lines = [`canon/config.yaml in ${root} (this checkout); changing it lands like any other change`, ""];
  for (const v of views) lines.push(`${v.key} = ${value(v)}`, `  ${v.doc}`);
  return lines.join("\n");
}

/** The line to print when canon/config.yaml does not start with the modeline; undefined when it does. */
export function modelineHint(root: string): string | undefined {
  const path = join(root, "canon", "config.yaml");
  const first = existsSync(path) ? (readFileSync(path, "utf8").split("\n")[0] ?? "") : "";
  if (first.trim() === MODELINE) return undefined;
  return `editor completion: make this the first line of canon/config.yaml: ${MODELINE}`;
}

/**
 * Writes `<root>/.canon/config.schema.json` (BR-2176). Returns what went wrong, for the caller to say; it never throws.
 */
export const writeSchemaFile = (root: string): Result<void> => writeGenerated(root, SCHEMA_FILE, schemaText());

/**
 * Writes `text` to `<root>/<file>` under `.canon/` when its content differs, through a temporary file and a rename so a
 * concurrent reader never sees half a file, after making sure the repository's shared info/exclude ignores `/.canon/`
 * (BR-2176, BR-2541). Returns what went wrong, for the caller to say; it never throws.
 */
export function writeGenerated(root: string, file: string, text: string): Result<void> {
  try {
    const excluded = excludeGenerated(root);
    if (!excluded.ok) return excluded;
    const path = join(root, file);
    if (existsSync(path) && readFileSync(path, "utf8") === text) return ok(undefined);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return ok(undefined);
  } catch (e) {
    return err("io", `cannot write ${file}: ${(e as Error).message}`);
  }
}

const EXCLUDE_LINE = `/${GENERATED_DIR}/`;

function excludeGenerated(root: string): Result<void> {
  const added = ensureExcluded(root, EXCLUDE_LINE);
  return added.ok ? ok(undefined) : added;
}
