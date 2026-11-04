import { posix } from "node:path";

/**
 * Tests that run the CLI by spawning it import none of the code they exercise, so the import reading of
 * `canon work test` (BR-2157) cannot see what they depend on. This file reads it from the test and from the
 * command table instead (D-60): which file starts the CLI, and which commands the test names.
 */

/** A command the CLI registers: `entry("status", 50, status, "work")` is `work status`, owned by the file that wrote it. */
export interface RegisteredCommand {
  readonly words: readonly string[];
  readonly module: string;
}

/** What a test that spawns the CLI depends on: the file that starts it and the command modules it drives. */
export interface CliDrive {
  readonly entry: string;
  readonly driven: readonly RegisteredCommand[];
}

// entry("name", rank, command) and entry("name", rank, command, "group"), as src/cli/command.ts defines them (C-132)
const ENTRY_CALL = /\bentry\(\s*"([^"]+)"\s*,\s*\d+\s*,\s*[\w.]+\s*(?:,\s*"([^"]+)"\s*)?\)/g;
// join(import.meta.dir, "..", "cli", "main.ts") or resolve(...): a path written only from string literals
const DIR_PATH = /\b(?:join|resolve)\(\s*import\.meta\.dir((?:\s*,\s*(?:"[^"\n]*"|'[^'\n]*'))+)\s*\)/g;

/** The repo paths a test builds from `import.meta.dir` and string literals, the way tests name the CLI's entry file. */
export function pathsBuiltFromDir(testFile: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DIR_PATH)) {
    const parts = [...m[1]!.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((p) => p[1] ?? p[2] ?? "");
    const path = posix.normalize(posix.join(posix.dirname(testFile), ...parts));
    if (!path.startsWith("../") && path !== "..") out.add(path);
  }
  return [...out];
}

/** The commands a source file registers with `entry(...)`; the empty list for a file that registers none. Comments are not read: one that shows a call is no registration. */
export function commandsRegisteredIn(file: string, text: string): RegisteredCommand[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(ENTRY_CALL)].map((m) => ({ words: m[2] ? [m[2], m[1]!] : [m[1]!], module: file }));
}

const QUOTE = "[\"'`]";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when the test text names the command: its words as consecutive string literals (`"work", "status"`), or written
 * together in one literal (`"work status --json"`). A one-word command counts only when it is a whole literal.
 */
export function namesCommand(text: string, words: readonly string[]): boolean {
  const w = words.map(escape);
  const separate = new RegExp(`${QUOTE}${w.join(`${QUOTE}\\s*,\\s*${QUOTE}`)}${QUOTE}`);
  if (separate.test(text)) return true;
  return words.length > 1 && new RegExp(`${QUOTE}${w.join("\\s+")}(?:\\s[^"'\`]*)?${QUOTE}`).test(text);
}
