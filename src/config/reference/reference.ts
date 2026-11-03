import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { CONFIG_KEYS } from "../config.ts";
import type { JsonSchema } from "../key.ts";

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
    properties: Object.fromEntries(KEYS.map((k) => [k.key, { ...k.schema, description: k.doc }])),
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
    const set = Object.hasOwn(raw, k.key);
    return { key: k.key, set, value: set ? raw[k.key] : null, default: k.schema["default"] ?? null, doc: k.doc };
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
 * Writes `<root>/.canon/config.schema.json` when its content differs, through a temporary file and a rename so a
 * concurrent reader never sees half a file, after making sure the repository's shared info/exclude ignores `/.canon/`
 * (BR-2176). Returns what went wrong, for the caller to say; it never throws.
 */
export function writeSchemaFile(root: string): Result<void> {
  try {
    const excluded = excludeGenerated(root);
    if (!excluded.ok) return excluded;
    const dir = join(root, GENERATED_DIR);
    const file = join(root, SCHEMA_FILE);
    const text = schemaText();
    if (existsSync(file) && readFileSync(file, "utf8") === text) return ok(undefined);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return ok(undefined);
  } catch (e) {
    return err("io", `cannot write ${SCHEMA_FILE}: ${(e as Error).message}`);
  }
}

const EXCLUDE_LINE = `/${GENERATED_DIR}/`;

function excludeGenerated(root: string): Result<void> {
  const common = git(root, "rev-parse", "--git-common-dir");
  if (!common.ok) return common;
  const dir = isAbsolute(common.value) ? common.value : join(root, common.value);
  const file = join(dir, "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((l) => l.trim() === EXCLUDE_LINE)) return ok(undefined);
  mkdirSync(join(dir, "info"), { recursive: true });
  // reason: every worktree's git reads this file; appending never empties it and never drops a line someone else
  // added since the read. Two sessions racing may both append, and a repeated line is harmless (issue #44, BR-2176).
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${EXCLUDE_LINE}\n`);
  return ok(undefined);
}
