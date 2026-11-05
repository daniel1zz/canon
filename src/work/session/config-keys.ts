import { resolve } from "node:path";
import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, stringValue } from "../../invocation/key.ts";

/** Build output, dependency and cache directories of common toolchains: rebuilt by `setup` or a build, never hand-made. */
export const DEFAULT_REGENERABLE: readonly string[] = [
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv", ".gradle", "*.pyc", ".DS_Store",
];

/** canon/config.yaml keys of change worktrees (C-135). */
export const sessionKeys = {
  setup: configKey<string | undefined>({
    key: "setup",
    doc: 'Shell command run once in a new worktree, with CANON_PORT (BR-2267); keep it to installing dependencies: "bun install" with bun\'s defaults, or "pnpm install" with `virtualStoreType: global` in pnpm-workspace.yaml (C-103).',
    default: undefined,
    schema: optionalString,
    read: stringValue("setup"),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 50,
    checked: 30,
  }),
  worktrees: configKey<string | undefined>({
    key: "worktrees",
    doc: "Where change worktrees live, relative to the primary checkout; unset means `<primary>.worktrees` (BR-2047).",
    default: undefined,
    schema: optionalString,
    read: stringValue("worktrees"),
    listed: 120,
    checked: 50,
  }),
  regenerable: configKey<readonly string[]>({
    key: "regenerable",
    doc: "Names (globs, matched against each path segment) of git-ignored files a worktree can rebuild, such as node_modules; removing a worktree loses nothing by deleting them (BR-2019). Any other ignored file counts as work.",
    default: DEFAULT_REGENERABLE,
    schema: { type: "array", items: { type: "string", pattern: "^[^/]*[^\\s/][^/]*$" }, default: DEFAULT_REGENERABLE },
    read: (v) =>
      !Array.isArray(v) || v.some((t) => typeof t !== "string" || t.trim() === "" || t.includes("/"))
        ? err("invalid", "`regenerable` must be a list of file or directory names (globs allowed, no `/`)")
        : ok(v as string[]),
    listed: 140,
    checked: 80,
  }),
};

/** Where change worktrees live (BR-2047): configured (relative to the primary checkout) or `<primary>.worktrees`. */
export function worktreesDirOf(config: { readonly worktrees: string | undefined }, primary: string): string {
  if (!config.worktrees) return `${primary.replace(/\/+$/, "")}.worktrees`;
  return resolve(primary, config.worktrees).replace(/\/+$/, "");
}
