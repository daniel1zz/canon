import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * `canon/config.yaml` — the few project facts canon cannot infer.
 *   main:  the branch changes land on (default "main")
 *   floor: shell command that must exit 0 on the exact tree that becomes main (required to land)
 *   tests: globs of test files scanned for rule ids (default: every *.test.* / *.spec.*)
 */
export interface Config {
  readonly main: string;
  readonly floor: string | undefined;
  readonly tests: readonly string[] | undefined;
  /** Shell command run once in a new worktree (e.g. "bun install"). */
  readonly setup: string | undefined;
  /**
   * Reviewer for rule and decision text (design §4). Receives the review prompt on stdin and prints JSON
   * `{"verdict":"ok"|"block","findings":["..."]}`. Runs at land only when canon/rules or canon/decisions changed.
   */
  readonly review: string | undefined;
  /** Advisory command run after a successful landing (e.g. a code review that files issues); never blocks. */
  readonly afterLand: string | undefined;
}

export function readConfig(root: string): Result<Config> {
  const path = join(root, "canon", "config.yaml");
  if (!existsSync(path)) return ok({ main: "main", floor: undefined, tests: undefined, setup: undefined, review: undefined, afterLand: undefined });
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8")) ?? {};
  } catch (e) {
    return err("invalid", `canon/config.yaml is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("invalid", "canon/config.yaml must be a mapping");
  const c = raw as Record<string, unknown>;
  const main = c["main"] ?? "main";
  const floor = c["floor"];
  const tests = c["tests"];
  if (typeof main !== "string") return err("invalid", "config `main` must be a branch name");
  if (floor !== undefined && typeof floor !== "string") return err("invalid", "config `floor` must be a shell command");
  if (tests !== undefined && (!Array.isArray(tests) || tests.some((t) => typeof t !== "string"))) return err("invalid", "config `tests` must be a list of globs");
  const commands: Record<string, string | undefined> = {};
  for (const key of ["setup", "review", "after_land"]) {
    const v = c[key];
    if (v !== undefined && typeof v !== "string") return err("invalid", `config \`${key}\` must be a shell command`);
    commands[key] = v === "" ? undefined : (v as string | undefined);
  }
  return ok({
    main,
    floor: floor === "" ? undefined : (floor as string | undefined),
    tests: tests as string[] | undefined,
    setup: commands["setup"],
    review: commands["review"],
    afterLand: commands["after_land"],
  });
}
