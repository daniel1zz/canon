import { parse } from "yaml";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";

/** One key declaration in a domain's `config-keys.ts`, as `configKey` takes it (C-135). */
const DECLARATION = /^\s*key: "([A-Za-z0-9_]+)",\s*$/gm;

/** The config keys the `config-keys.ts` files of tree `rev` declare (BR-2248); one `git grep`. */
function declaredKeys(cwd: string, rev: string): Result<Set<string>> {
  const r = Bun.spawnSync(["git", "grep", "-h", "-E", "-e", '^[[:space:]]*key: "[A-Za-z0-9_]+",[[:space:]]*$', rev, "--", ":(glob)**/config-keys.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
  // reason: git grep exits 1 when nothing matches, which is a tree without declarations, not an error
  if (r.exitCode === 1 && r.stderr.toString().trim() === "") return ok(new Set());
  if (r.exitCode !== 0) return err("io", `git grep for config key declarations in ${rev.slice(0, 9)}: ${r.stderr.toString().trim()}`);
  return ok(new Set([...r.stdout.toString().matchAll(DECLARATION)].map((m) => m[1]!)));
}

/** The top-level keys `canon/config.yaml` of tree `rev` uses; none when it has no such file or it is no mapping. */
function usedKeys(cwd: string, rev: string): string[] {
  const shown = git(cwd, "show", `${rev}:canon/config.yaml`);
  if (!shown.ok) return [];
  let raw: unknown;
  try {
    raw = parse(shown.value);
  } catch {
    return []; // reason: a config that does not parse is refused by every command already (BR-2045)
  }
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
}

/**
 * BR-2248: the keys `head`'s `canon/config.yaml` uses that `head` declares and `main` (main's base commit) does not.
 * An older canon, the one other sessions run until it is rebuilt, fails every command on such a key (BR-2045).
 * Empty when `main` declares no key at all: the repository is a project that uses canon, not canon itself.
 */
export function keysAddedAndUsed(cwd: string, main: string, head: string): Result<string[]> {
  const before = declaredKeys(cwd, main);
  if (!before.ok) return before;
  if (before.value.size === 0) return ok([]);
  const after = declaredKeys(cwd, head);
  if (!after.ok) return after;
  return ok(usedKeys(cwd, head).filter((k) => after.value.has(k) && !before.value.has(k)));
}

/** The refusal message for BR-2248. */
export function keysAddedAndUsedMessage(keys: readonly string[], main: string): string {
  const list = keys.map((k) => `\`${k}\``).join(", ");
  return (
    `canon/config.yaml uses ${list}, which this landing adds to canon's code; the canon of main (${main.slice(0, 9)}) does not know ${keys.length === 1 ? "it" : "them"}, ` +
    "so every session's installed canon would fail every command with exit 2 (BR-2045) until it is rebuilt.\n" +
    `Land the key first without using it, then set it in canon/config.yaml in a second landing (BR-2248).`
  );
}

/** One check name in a `checks.ts` file: every double-quoted name there is a check (BR-2248). */
const CHECK_NAME = /"([a-z][a-z0-9-]*)"/g;

/** The check names the `checks.ts` files of tree `rev` declare (BR-2248); one `git grep`. */
function declaredChecks(cwd: string, rev: string): Result<Set<string>> {
  const r = Bun.spawnSync(["git", "grep", "-h", "-E", "-e", '"[a-z][a-z0-9-]*"', rev, "--", ":(glob)**/checks.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
  // reason: git grep exits 1 when nothing matches, which is a tree without check declarations, not an error
  if (r.exitCode === 1 && r.stderr.toString().trim() === "") return ok(new Set());
  if (r.exitCode !== 0) return err("io", `git grep for check name declarations in ${rev.slice(0, 9)}: ${r.stderr.toString().trim()}`);
  return ok(new Set([...r.stdout.toString().matchAll(CHECK_NAME)].map((m) => m[1]!)));
}

/** The check names under `check_reviews` in `canon/config.yaml` of tree `rev`; none when it has no such mapping. */
function reviewedChecks(cwd: string, rev: string): string[] {
  const shown = git(cwd, "show", `${rev}:canon/config.yaml`);
  if (!shown.ok) return [];
  let raw: unknown;
  try {
    raw = parse(shown.value);
  } catch {
    return []; // reason: a config that does not parse is refused by every command already (BR-2045)
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const reviews = (raw as Record<string, unknown>)["check_reviews"];
  return reviews !== null && typeof reviews === "object" && !Array.isArray(reviews) ? Object.keys(reviews) : [];
}

/**
 * BR-2248: the check names `head`'s `check_reviews` uses that `head` declares and `main` (main's base commit) does not.
 * An older canon fails every command on a check name it does not know (BR-2069, BR-2045).
 * Empty when `main` declares no check name at all: the repository is a project that uses canon, not canon itself.
 */
export function checksAddedAndReviewed(cwd: string, main: string, head: string): Result<string[]> {
  const before = declaredChecks(cwd, main);
  if (!before.ok) return before;
  if (before.value.size === 0) return ok([]);
  const after = declaredChecks(cwd, head);
  if (!after.ok) return after;
  return ok(reviewedChecks(cwd, head).filter((c) => after.value.has(c) && !before.value.has(c)));
}

/** The refusal message for BR-2248 when check names are added and given a review date in one landing. */
export function checksAddedAndReviewedMessage(checks: readonly string[], main: string): string {
  const list = checks.map((c) => `\`${c}\``).join(", ");
  return (
    `check_reviews in canon/config.yaml names ${list}, which this landing adds to canon's checks; the canon of main (${main.slice(0, 9)}) does not know ${checks.length === 1 ? "it" : "them"}, ` +
    "so every session's installed canon would fail every command with exit 2 (BR-2069, BR-2045) until it is rebuilt.\n" +
    `Land the check first without a review date, then add it to check_reviews in a second landing (BR-2248).`
  );
}
