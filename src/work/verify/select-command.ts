import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * The project's `test_select_command` (BR-2346, D-64): the one place canon asks "which test files can this change break"
 * beyond what it reads from the ledger. Standard input: the changed repository paths, one per line, relative to the root;
 * standard output: one test file per line, optionally a tab and why. canon neither reads the project's source nor knows its language.
 */

/** The longest the command may run before `canon work test` or the landing refuses it. */
export const SELECT_TIMEOUT_MS = 120_000;

export interface Chosen {
  readonly file: string;
  readonly reason: string;
}

export interface Chosen2 {
  readonly chosen: readonly Chosen[];
  /** What the command printed on standard error, a line each. */
  readonly notes: readonly string[];
}

/**
 * Runs `command` in `root` with `changed` on standard input. A non-zero exit, a timeout, or a printed path that is not an
 * existing file matching `tests` fails (exit 4 for the caller, BR-2346); canon never falls back to selecting without it.
 */
export function runSelectCommand(root: string, command: string, changed: readonly string[], tests: ReadonlySet<string>): Result<Chosen2> {
  const r = Bun.spawnSync(["sh", "-c", command], { cwd: root, stdin: new TextEncoder().encode(changed.map((p) => `${p}\n`).join("")), stdout: "pipe", stderr: "pipe", timeout: SELECT_TIMEOUT_MS });
  const tail = (text: string) => text.trimEnd().split("\n").slice(-20).join("\n");
  if (r.exitedDueToTimeout) return err("io", `test_select_command did not finish in ${SELECT_TIMEOUT_MS / 1000}s: ${command}`);
  if (r.exitCode !== 0) return err("io", `test_select_command exited ${r.exitCode}: ${command}\n${tail(`${r.stderr.toString()}${r.stdout.toString()}`)}`);
  const chosen: Chosen[] = [];
  const bad: string[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const file = tab < 0 ? line : line.slice(0, tab);
    const reason = tab < 0 ? "" : line.slice(tab + 1).trim();
    const full = join(root, file);
    if (!tests.has(file) || !existsSync(full) || !statSync(full).isFile()) bad.push(file);
    else chosen.push({ file, reason });
  }
  if (bad.length > 0) return err("io", `test_select_command printed ${bad.length} path(s) that are not existing files matching \`tests\`: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""}`);
  return ok({ chosen, notes: r.stderr.toString().split("\n").filter((l) => l !== "") });
}
