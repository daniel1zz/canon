import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { err, ok, type Result } from "../kernel/result.ts";
import { checkKeys } from "../knowledge/check/config-keys.ts";
import { reviewKeys } from "../knowledge/review/config-keys.ts";
import { claimKeys } from "../work/claims/config-keys.ts";
import { landKeys } from "../work/land/config-keys.ts";
import { sessionKeys } from "../work/session/config-keys.ts";
import { statsKeys } from "../work/stats/config-keys.ts";
import { verifyKeys } from "../work/verify/config-keys.ts";
import { documentKeys, hookKeys, readTemplates } from "./config-keys.ts";
import type { ConfigKey, FieldsOf, KeySet } from "./key.ts";

/**
 * `canon/config.yaml`: the project facts canon cannot infer and every extension point (D-2, D-3).
 * Reading is strict (BR-2045): an unknown key, a wrong type, a missing script or a template for an
 * undeclared type makes every command fail with exit 2 instead of silently using a default.
 *
 * Every key is declared (name, type, default, validation, doc) by the domain that uses it, in `config-keys.ts` in that
 * domain's directory; this file only composes them, so it changes when a domain is added, not when a key is (C-135).
 */
const DOMAINS = [hookKeys, checkKeys, documentKeys, reviewKeys, claimKeys, landKeys, sessionKeys, statsKeys, verifyKeys] as const;

type Sections = typeof DOMAINS[number];
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

export type Config = UnionToIntersection<Sections extends infer S ? (S extends KeySet ? FieldsOf<S> : never) : never> & {
  /** Type name → template body from `canon/templates/<name>.md`. */
  readonly templates: Readonly<Record<string, string>>;
};

/** Every key with the Config field it fills. A field or key name two domains declare is a bug in canon and throws. */
export const CONFIG_KEYS: readonly (readonly [string, ConfigKey<unknown>])[] = (() => {
  const fields = new Set<string>();
  const names = new Set<string>();
  const out: (readonly [string, ConfigKey<unknown>])[] = [];
  for (const set of DOMAINS as readonly KeySet[]) {
    for (const [field, k] of Object.entries(set)) {
      if (fields.has(field) || names.has(k.key)) throw new Error(`two domains declare the config field ${field} or key ${k.key}`);
      fields.add(field);
      names.add(k.key);
      out.push([field, k]);
    }
  }
  return out;
})();

const LISTED = [...CONFIG_KEYS].sort((a, b) => a[1].listed - b[1].listed).map(([, k]) => k.key);
const CHECKED = [...CONFIG_KEYS].sort((a, b) => a[1].checked - b[1].checked);
const MOVED: Record<string, string> = Object.assign({}, ...CONFIG_KEYS.map(([, k]) => k.replaces ?? {}));

export function readConfig(root: string): Result<Config> {
  const path = join(root, "canon", "config.yaml");
  const bad = (message: string) => err("invalid", `canon/config.yaml: ${message}`);
  let c: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(path, "utf8")) ?? {};
    } catch (e) {
      return bad(`not valid YAML: ${(e as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("must be a mapping");
    c = raw as Record<string, unknown>;
  }
  for (const key of Object.keys(c)) {
    if (MOVED[key]) return bad(`\`${key}\` moved to \`${MOVED[key]}\``);
    if (!LISTED.includes(key)) return bad(`unknown key \`${key}\` (known: ${LISTED.join(", ")})`);
  }

  const values: Record<string, unknown> = {};
  const commands: string[] = [];
  for (const [field, k] of CHECKED) {
    const v = c[k.key];
    const r = v === undefined ? ok(k.default) : k.read(v, { root, raw: c });
    if (!r.ok) return bad(r.error.message);
    values[field] = r.value;
    commands.push(...(k.commands?.(r.value) ?? []));
  }
  for (const cmd of commands) {
    const missing = missingScript(root, cmd);
    if (missing) return bad(`command \`${cmd}\` runs ${missing}, which does not exist`);
  }
  const config = values as Omit<Config, "templates">;
  const templates = readTemplates(root, config.types);
  if (!templates.ok) return bad(templates.error.message);
  return ok({ ...config, templates: templates.value } as Config);
}

/**
 * The script a command starts with when it is written as a path (`scripts/review.sh`, `./x`, `/abs/x`),
 * when that file does not exist; undefined otherwise. Bare program names on PATH are not checked (D-3).
 */
function missingScript(root: string, command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "") ?? "";
  if (!first.includes("/") || first.includes("$")) return undefined;
  const full = isAbsolute(first) ? first : resolve(root, first);
  return existsSync(full) ? undefined : first;
}
