import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * BR-2300: a Bun child started without `env` gets the environment bun launched with, so a test that assigns
 * process.env and then spawns that way may verify nothing. Found statically and only hinted, never a finding:
 * the judgement has false positives (a PATH change used only to find the executable, a child that never reads it).
 */

const JS_TS = /\.[cm]?[jt]sx?$/;
const ASSIGN = /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])\s*(?:=(?![=>])|\+=|\?\?=|\|\|=|&&=)|\bdelete\s+process\.env\b|\bObject\.assign\(\s*process\.env\b/;
const SPAWN = /\bBun\.spawn(?:Sync)?\(/g;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** A line that is only a comment: `//` or a `*` continuation of a block comment. */
const commentLine = (line: string) => /^\s*(?:\/\/|\*|\/\*)/.test(line);

/** The index just past a string or template literal starting at `i`. */
function skipString(text: string, i: number): number {
  const q = text[i]!;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === q) return j + 1;
    else if (q !== "`" && text[j] === "\n") return j;
  }
  return text.length;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, each as its source text, or undefined when the call
 * does not close. Nested brackets and string literals are skipped; text inside them is replaced by spaces in
 * `shallow`, so a key test sees only the argument's own top level.
 */
function callArgs(text: string, open: number): { full: string; shallow: string }[] | undefined {
  const args: { full: string; shallow: string }[] = [];
  const stack: string[] = [];
  let start = open + 1;
  let shallow = "";
  for (let i = open + 1; i < text.length; ) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i);
      shallow += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (OPEN[c]) {
      // reason: an argument's own braces stay visible, so its top-level keys can be read (BR-2300)
      shallow += stack.length === 0 ? c : " ";
      stack.push(OPEN[c]!);
    } else if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      shallow += stack.length === 0 ? c : " ";
    } else if (c === ")" && stack.length === 0) {
      args.push({ full: text.slice(start, i).trim(), shallow: shallow.trim() });
      return args.filter((a) => a.full !== "");
    } else if (c === "," && stack.length === 0) {
      args.push({ full: text.slice(start, i).trim(), shallow: shallow.trim() });
      start = i + 1;
      shallow = "";
    } else shallow += stack.length <= 1 ? c : " ";
    i++;
  }
  return undefined;
}

/** True when the call is known to start its child without `env`. */
function withoutEnv(args: { full: string; shallow: string }[]): boolean {
  const options = args.length === 1 && args[0]!.full.startsWith("{") ? args[0]! : args[1];
  if (!options) return true;
  // reason: options held in a variable or built by a call cannot be read, so they are not hinted (BR-2300)
  if (!options.full.startsWith("{")) return false;
  return !/(?:^|[{,])\s*(?:env\s*(?:[:,}]|$)|\.\.\.)/.test(options.shallow);
}

export interface EnvSpawnHint {
  readonly file: string;
  /** The first line that assigns process.env. */
  readonly assignLine: number;
  /** Lines of the Bun.spawn / Bun.spawnSync calls known to pass no env, in file order. */
  readonly spawnLines: readonly number[];
}

/** One hint per test file that assigns process.env and starts a Bun child without env (BR-2300). */
export function envSpawnHints(root: string, testFiles: readonly string[]): EnvSpawnHint[] {
  const out: EnvSpawnHint[] = [];
  for (const file of testFiles) {
    if (!JS_TS.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split("\n");
    const assignLine = lines.findIndex((l) => !commentLine(l) && ASSIGN.test(l)) + 1;
    if (assignLine === 0) continue;
    const lineOf = (i: number) => text.slice(0, i).split("\n").length;
    const spawnLines: number[] = [];
    for (const m of text.matchAll(SPAWN)) {
      const line = lineOf(m.index!);
      if (commentLine(lines[line - 1]!)) continue;
      const args = callArgs(text, m.index! + m[0].length - 1);
      if (args && withoutEnv(args) && !spawnLines.includes(line)) spawnLines.push(line);
    }
    if (spawnLines.length) out.push({ file, assignLine, spawnLines });
  }
  return out;
}

export const renderEnvSpawnHint = (h: EnvSpawnHint) =>
  `hint env-spawn: ${h.file}:${h.assignLine}: assigns process.env and starts Bun children without env (line${h.spawnLines.length > 1 ? "s" : ""} ${h.spawnLines.join(", ")}); they get the environment bun started with, not that change: pass env: { ...process.env } or set the variable before bun starts`;
