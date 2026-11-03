import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { err, ok, type Result } from "../kernel/result.ts";
import { templateFor } from "../knowledge/documents/templates.ts";
import { BUILTIN_TYPES, RESERVED_DIRS, RESERVED_FIELDS, type DocType } from "../knowledge/documents/types.ts";
import { CHECKS } from "../work/stats/checks.ts";

/**
 * `canon/config.yaml`: the project facts canon cannot infer and every extension point (D-2, D-3).
 * Reading is strict (BR-2045): an unknown key, a wrong type, a missing script or a template for an
 * undeclared type makes every command fail with exit 2 instead of silently using a default.
 */
export type HookEvent = "after_start" | "before_land" | "after_land" | "after_stop";
export const HOOK_EVENTS: readonly HookEvent[] = ["after_start", "before_land", "after_land", "after_stop"];

export interface Config {
  /** The branch changes land on. */
  readonly main: string;
  /** Shell command that must exit 0 on the exact tree that becomes main (required to land). */
  readonly floor: string | undefined;
  /** Globs of test files scanned for rule ids; undefined means the default discovery (BR-2046). */
  readonly tests: readonly string[] | undefined;
  /** Shell command run once in a new worktree (e.g. "bun install"). */
  readonly setup: string | undefined;
  /**
   * Reviewer for rule and decision text, the built-in first `before_land` step (D-3). Receives the review
   * prompt on stdin and prints JSON `{"verdict":"ok"|"block","findings":["..."]}`.
   */
  readonly review: string | undefined;
  /** Commands per lifecycle event, run in order. */
  readonly hooks: Readonly<Record<HookEvent, readonly string[]>>;
  /** How long a claim lasts without being renewed (BR-2011). */
  readonly claimLeaseMs: number;
  /** A lander silent this long is skipped (BR-2044). */
  readonly landerStaleMs: number;
  /** Default wait in the landing queue before giving up (BR-2048). */
  readonly landTimeoutMs: number;
  /** Where change worktrees live; undefined means `<primary>.worktrees` (BR-2047). */
  readonly worktrees: string | undefined;
  /** Built-in types followed by the declared ones. */
  readonly types: readonly DocType[];
  /** Type name → template body from `canon/templates/<name>.md`. */
  readonly templates: Readonly<Record<string, string>>;
  /** Check name → the date (YYYY-MM-DD) it is due for review (BR-2069). */
  readonly checkReviews: Readonly<Record<string, string>>;
  /**
   * Names (globs, matched against each path segment) of git-ignored files a worktree can rebuild, such as
   * node_modules; removing a worktree loses nothing by deleting them (BR-2019). Any other ignored file counts as work.
   */
  readonly regenerable: readonly string[];
  /**
   * The directory whose subdirectories mirror the rule domains one to one (`<codeRoot>/<domain path>`, D-15);
   * undefined means top-level domain READMEs list their code directories instead.
   */
  readonly codeRoot: string | undefined;
  /** Directories (or files) under codeRoot that belong to no business domain, such as a shared kernel; empty without codeRoot. */
  readonly shared: readonly string[];
}

const HOUR = 3_600_000;

/** Build output, dependency and cache directories of common toolchains: rebuilt by `setup` or a build, never hand-made. */
export const DEFAULT_REGENERABLE: readonly string[] = [
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv", ".gradle", "*.pyc", ".DS_Store",
];
const MINUTE = 60_000;

export const DEFAULT_CONFIG: Config = {
  main: "main",
  floor: undefined,
  tests: undefined,
  setup: undefined,
  review: undefined,
  hooks: { after_start: [], before_land: [], after_land: [], after_stop: [] },
  claimLeaseMs: 12 * HOUR,
  landerStaleMs: 10 * MINUTE,
  landTimeoutMs: 60 * MINUTE,
  worktrees: undefined,
  types: BUILTIN_TYPES,
  templates: {},
  checkReviews: {},
  regenerable: DEFAULT_REGENERABLE,
  codeRoot: undefined,
  shared: [],
};

const TOP_KEYS = new Set(["main", "floor", "tests", "setup", "review", "hooks", "types", "claim_lease_hours", "lander_stale_minutes", "land_timeout_minutes", "worktrees", "check_reviews", "regenerable", "code_root", "shared"]);
const TYPE_KEYS = new Set(["prefix", "dir", "statuses", "default", "fields", "sections"]);
const MOVED: Record<string, string> = { after_land: "hooks.after_land" };

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
    if (!TOP_KEYS.has(key)) return bad(`unknown key \`${key}\` (known: ${[...TOP_KEYS].join(", ")})`);
  }

  const str = (key: string): Result<string | undefined> => {
    const v = c[key];
    if (v === undefined || v === null || v === "") return ok(undefined);
    return typeof v === "string" ? ok(v) : bad(`\`${key}\` must be a string`);
  };
  const positive = (key: string, unit: number, fallback: number): Result<number> => {
    const v = c[key];
    if (v === undefined) return ok(fallback);
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? ok(v * unit) : bad(`\`${key}\` must be a number greater than 0`);
  };

  const main = str("main");
  const floor = str("floor");
  const setup = str("setup");
  const review = str("review");
  const worktrees = str("worktrees");
  for (const r of [main, floor, setup, review, worktrees]) if (!r.ok) return r;
  const tests = c["tests"];
  if (tests !== undefined && (!Array.isArray(tests) || tests.some((t) => typeof t !== "string"))) return bad("`tests` must be a list of globs");
  const regenerable = c["regenerable"];
  if (regenerable !== undefined && (!Array.isArray(regenerable) || regenerable.some((t) => typeof t !== "string" || t.trim() === "" || t.includes("/")))) {
    return bad("`regenerable` must be a list of file or directory names (globs allowed, no `/`)");
  }
  const layout = readLayout(c["code_root"], c["shared"]);
  if (!layout.ok) return bad(layout.error.message);
  const lease = positive("claim_lease_hours", HOUR, DEFAULT_CONFIG.claimLeaseMs);
  const stale = positive("lander_stale_minutes", MINUTE, DEFAULT_CONFIG.landerStaleMs);
  const timeout = positive("land_timeout_minutes", MINUTE, DEFAULT_CONFIG.landTimeoutMs);
  for (const r of [lease, stale, timeout]) if (!r.ok) return r;

  const hooks = readHooks(c["hooks"]);
  if (!hooks.ok) return bad(hooks.error.message);
  const types = readTypes(c["types"]);
  if (!types.ok) return bad(types.error.message);

  const reviews = readCheckReviews(c["check_reviews"]);
  if (!reviews.ok) return bad(reviews.error.message);

  const commands = [floor, setup, review].map((r) => (r.ok ? r.value : undefined)).filter((x): x is string => x !== undefined);
  for (const cmd of [...commands, ...Object.values(hooks.value).flat()]) {
    const missing = missingScript(root, cmd);
    if (missing) return bad(`command \`${cmd}\` runs ${missing}, which does not exist`);
  }

  const templates: Record<string, string> = {};
  const tdir = join(root, "canon", "templates");
  if (existsSync(tdir)) {
    for (const file of readdirSync(tdir).filter((f) => f.endsWith(".md"))) {
      const name = file.slice(0, -3);
      if (!types.value.some((t) => t.name === name)) return bad(`canon/templates/${file} is a template for \`${name}\`, which is not a document type`);
      templates[name] = readFileSync(join(tdir, file), "utf8");
    }
  }
  // The template a new document starts from, the project's or the built-in one, carries every required section (BR-2092).
  for (const t of types.value) {
    const lines = templateFor(t.name, templates, t.sections).split("\n").map((l) => l.trim());
    const missing = t.sections.filter((s) => !lines.includes(`## ${s}`));
    if (!missing.length) continue;
    const where = t.name in templates ? `canon/templates/${t.name}.md` : `the built-in ${t.name} template (add canon/templates/${t.name}.md)`;
    return bad(`${where} lacks required section(s) ${missing.map((s) => `\`## ${s}\``).join(", ")} of type \`${t.name}\``);
  }

  return ok({
    main: (main.ok && main.value) || "main",
    floor: floor.ok ? floor.value : undefined,
    tests: tests as string[] | undefined,
    setup: setup.ok ? setup.value : undefined,
    review: review.ok ? review.value : undefined,
    hooks: hooks.value,
    claimLeaseMs: lease.ok ? lease.value : DEFAULT_CONFIG.claimLeaseMs,
    landerStaleMs: stale.ok ? stale.value : DEFAULT_CONFIG.landerStaleMs,
    landTimeoutMs: timeout.ok ? timeout.value : DEFAULT_CONFIG.landTimeoutMs,
    worktrees: worktrees.ok ? worktrees.value : undefined,
    types: types.value,
    templates,
    checkReviews: reviews.value,
    regenerable: (regenerable as string[] | undefined) ?? DEFAULT_REGENERABLE,
    codeRoot: layout.value.codeRoot,
    shared: layout.value.shared,
  });
}

/** A repo-relative directory: no absolute path, no `..` or `.` segment, no trailing slash. */
const REL_DIR = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\s]+(?<!\/)$/;

/** `code_root` and `shared` (BR-2116): shared only makes sense under a code root, and each entry lies inside it. */
function readLayout(root: unknown, shared: unknown): Result<{ codeRoot: string | undefined; shared: string[] }> {
  if (root !== undefined && root !== null && (typeof root !== "string" || !REL_DIR.test(root))) {
    return err("invalid", "`code_root` must be a directory relative to the repository root, such as src");
  }
  const codeRoot = typeof root === "string" ? root : undefined;
  if (shared === undefined || shared === null) return ok({ codeRoot, shared: [] });
  if (codeRoot === undefined) return err("invalid", "`shared` needs `code_root`: it lists directories under the code root that are no domain's");
  if (!Array.isArray(shared) || shared.some((s) => typeof s !== "string" || !REL_DIR.test(s) || !s.startsWith(`${codeRoot}/`))) {
    return err("invalid", `\`shared\` must be a list of directories under ${codeRoot}, such as ${codeRoot}/kernel`);
  }
  return ok({ codeRoot, shared: shared as string[] });
}

function readCheckReviews(v: unknown): Result<Record<string, string>> {
  if (v === undefined || v === null) return ok({});
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`check_reviews` must be a mapping of check name → date (YYYY-MM-DD)");
  const out: Record<string, string> = {};
  for (const [name, date] of Object.entries(v as Record<string, unknown>)) {
    if (!CHECKS.includes(name)) return err("invalid", `\`check_reviews.${name}\`: no such check (checks: ${CHECKS.join(", ")})`);
    const text = date instanceof Date ? date.toISOString().slice(0, 10) : date;
    // Date.parse accepts 2026-02-30 (it rolls over to March), so the date must survive a round trip.
    const real = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (!real) return err("invalid", `\`check_reviews.${name}\` must be a real date like 2027-02-01`);
    out[name] = text;
  }
  return ok(out);
}

function readHooks(v: unknown): Result<Record<HookEvent, readonly string[]>> {
  const out: Record<HookEvent, string[]> = { after_start: [], before_land: [], after_land: [], after_stop: [] };
  if (v === undefined || v === null) return ok(out);
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`hooks` must be a mapping of event → command or list of commands");
  for (const [event, cmds] of Object.entries(v as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) return err("invalid", `unknown hook event \`${event}\` (known: ${HOOK_EVENTS.join(", ")})`);
    const list = typeof cmds === "string" ? [cmds] : cmds;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || x.trim() === "")) return err("invalid", `\`hooks.${event}\` must be a command or a list of commands`);
    out[event as HookEvent] = list as string[];
  }
  return ok(out);
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

/** Where change worktrees live (BR-2047): configured (relative to the primary checkout) or `<primary>.worktrees`. */
export function worktreesDirOf(config: Config, primary: string): string {
  if (!config.worktrees) return `${primary.replace(/\/+$/, "")}.worktrees`;
  return resolve(primary, config.worktrees).replace(/\/+$/, "");
}
