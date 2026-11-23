import { err, ok, type Result } from "../kernel/result.ts";
import type { StepId } from "./flow.ts";

/**
 * One key of `canon/config.yaml`, declared by the domain that uses it in `config-keys.ts` in its own directory;
 * src/invocation/config.ts only composes and validates them, so a new key never edits a shared file (C-135, D-15).
 */
export interface ConfigKey<T> {
  /** Its name in canon/config.yaml. */
  readonly key: string;
  /** What it is for, the way a reader of canon/config.yaml needs it. */
  readonly doc: string;
  /** The value when the key is absent. */
  readonly default: T;
  /**
   * The key's JSON Schema (draft-07) fragment for editors, `default` written the way canon/config.yaml writes it (hours,
   * not milliseconds). It accepts every value `read` accepts; what it cannot express it leaves to `read` (BR-2175, D-28).
   */
  readonly schema: JsonSchema;
  /** Keys that must be set, not null, whenever this one is set and not null (they become the schema's `dependencies`). */
  readonly needs?: readonly string[];
  /**
   * Validates a value that is present (null included) and returns what Config holds, or an invalid error whose message
   * names the key; config.ts adds the `canon/config.yaml:` prefix. Keys are read in `checked` order and the first
   * error wins, so a reader may look at a key with a lower `checked` in `ctx.raw` knowing it is already valid.
   */
  readonly read: (value: unknown, ctx: KeyContext) => Result<T>;
  /** Place in the list of known keys an unknown key's error prints (lower first). */
  readonly listed: number;
  /** Place in the order keys are validated (lower first). */
  readonly checked: number;
  /** Shell commands the value names; one that starts with a script path that does not exist is a config error (D-3). */
  readonly commands?: (value: T) => readonly string[];
  /** Old top-level names this key replaced, each with where it went, e.g. after_land → hooks.after_land. */
  readonly replaces?: Readonly<Record<string, string>>;
  /** Where the key acts in canon's flow and whether a project can turn it off (BR-2540, D-140). */
  readonly flow: KeyFlow<T>;
}

/**
 * A key's place in canon's flow (src/invocation/flow.ts): `canon config --flow` lists it under each step it names
 * (BR-2540). Declared next to the key so a new key cannot be left out (D-140).
 */
export interface KeyFlow<T> {
  /** The steps this key configures, at least one. */
  readonly steps: readonly [StepId, ...StepId[]];
  readonly role: KeyRole;
  /** Why `step` does not run with this value (it names the key and the value); undefined when it runs. */
  readonly idle?: (value: T, step: StepId) => string | undefined;
  /** For a mapping key whose steps each use one entry, such as hooks: the entry `step` uses. */
  readonly part?: (step: StepId) => string;
}

/**
 * required: a command fails without it (`why` says which); optional: the project can turn what it does off (`off`
 * says how); tunable: a parameter with a working default.
 */
export type KeyRole =
  | { readonly kind: "required"; readonly why: string }
  | { readonly kind: "optional"; readonly off: string }
  | { readonly kind: "tunable" };

export const TUNABLE: KeyRole = { kind: "tunable" };
export const optional = (off: string): KeyRole => ({ kind: "optional", off });
export const required = (why: string): KeyRole => ({ kind: "required", why });

export interface KeyContext {
  /** The repository root. */
  readonly root: string;
  /** canon/config.yaml as parsed, every key. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A domain's keys, by the name of the Config field each one fills. */
// reason: each key has its own value type, so the record is typed loosely here and precisely through FieldsOf
export type KeySet = Readonly<Record<string, ConfigKey<any>>>;

/** The Config fields a domain's keys fill, each with its key's value type. */
export type FieldsOf<S extends KeySet> = { readonly [F in keyof S]: S[F] extends ConfigKey<infer T> ? T : never };

export const configKey = <T>(k: ConfigKey<T>): ConfigKey<T> => k;

/**
 * The group a policy key lives in: `policies.<group>` (BR-2638, D-164). Each group is declared by the domain that uses it,
 * like any key; a dotted key name is read from the nested mapping.
 */
export const POLICIES = "policies";

/** Where a key is written: `policies.agenda` under `policies:` → `agenda:`, any other key at the top (BR-2638). */
export function rawAt(raw: Readonly<Record<string, unknown>>, key: string): { readonly set: boolean; readonly value: unknown } {
  const [head, ...rest] = key.split(".");
  if (rest.length === 0) return Object.hasOwn(raw, key) ? { set: true, value: raw[key] } : { set: false, value: undefined };
  const parent = raw[head!];
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return { set: false, value: undefined };
  const sub = rest.join(".");
  return Object.hasOwn(parent, sub) ? { set: true, value: (parent as Record<string, unknown>)[sub] } : { set: false, value: undefined };
}

/**
 * Reads one policy group: a mapping whose entries are the group's own names, each checked by `entry`; an entry left out
 * keeps its default, an unknown one is a configuration error naming the group (BR-2638).
 */
export function readGroup<T extends object>(key: string, value: unknown, defaults: T, entry: { readonly [K in keyof T]: (v: unknown, name: string) => Result<T[K]> }): Result<T> {
  if (value === null) return ok(defaults);
  if (typeof value !== "object" || Array.isArray(value)) return err("invalid", `\`${key}\` must be a mapping of ${Object.keys(defaults).join(", ")}`);
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(defaults, name)) return err("invalid", `unknown entry \`${key}.${name}\` (known: ${Object.keys(defaults).join(", ")})`);
    const r = (entry[name as keyof T] as (v: unknown, n: string) => Result<unknown>)(v, `${key}.${name}`);
    if (!r.ok) return r;
    out[name] = r.value;
  }
  return ok(out as T);
}

/** A positive number entry of a policy group (BR-2638). */
export const positiveEntry = (v: unknown, name: string): Result<number> => (typeof v === "number" && v > 0 && Number.isFinite(v) ? ok(v) : err("invalid", `\`${name}\` must be a positive number`));
/** A whole number of at least 1 (BR-2638). */
export const countEntry = (v: unknown, name: string): Result<number> => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", `\`${name}\` must be a whole number of at least 1`));
/** One of `allowed` (BR-2638). */
export const oneOfEntry = <V extends string>(allowed: readonly V[]) => (v: unknown, name: string): Result<V> => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? ok(v as V) : err("invalid", `\`${name}\` must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`));

/** A JSON Schema fragment; kept loose because only editors and the schema tests read it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The schema of a string key that may be left empty or null (both mean unset, see stringValue). */
export const optionalString: JsonSchema = { type: ["string", "null"] };

/** The schema of a `positiveValue` key, in the unit canon/config.yaml writes. */
export const positiveNumber = (dflt: number): JsonSchema => ({ type: "number", exclusiveMinimum: 0, default: dflt });

// ---------------------------------------------------------------- readers several domains use

/** A string; empty and null mean unset. */
export const stringValue = (key: string) => (v: unknown): Result<string | undefined> => {
  if (v === null || v === "") return ok(undefined);
  return typeof v === "string" ? ok(v) : err("invalid", `\`${key}\` must be a string`);
};

/** A number greater than 0, times `unit` (hours or minutes into milliseconds). */
export const positiveValue = (key: string, unit: number) => (v: unknown): Result<number> =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? ok(v * unit) : err("invalid", `\`${key}\` must be a number greater than 0`);

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** A repo-relative directory: no absolute path, no `..` or `.` segment, no trailing slash. */
export const REL_DIR = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\s]+(?<!\/)$/;

/** The schema of one repo-relative path (REL_DIR). */
export const relPath: JsonSchema = { type: "string", pattern: REL_DIR.source };
