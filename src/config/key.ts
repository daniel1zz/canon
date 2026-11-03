import { err, ok, type Result } from "../kernel/result.ts";

/**
 * One key of `canon/config.yaml`, declared by the domain that uses it in `config-keys.ts` in its own directory;
 * src/config/config.ts only composes and validates them, so a new key never edits a shared file (C-135, D-15).
 */
export interface ConfigKey<T> {
  /** Its name in canon/config.yaml. */
  readonly key: string;
  /** What it is for, the way a reader of canon/config.yaml needs it. */
  readonly doc: string;
  /** The value when the key is absent. */
  readonly default: T;
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
}

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
