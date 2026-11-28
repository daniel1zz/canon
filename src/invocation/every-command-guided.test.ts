import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ArgsDef, CommandDef } from "citty";
import { main } from "./tree.ts";

const ROOT = join(import.meta.dir, "../..");
const SRC = join(ROOT, "src");

/**
 * Commands no agent needs to be led to (BR-2648): run by a host hook or a git hook, or by a person only. Every other
 * command must be named where an agent reads it. Add a command here only with the reason it needs no guidance.
 */
const EXEMPT: Record<string, string> = {
  "goal check": "run by the Stop hook (BR-2519)",
  restatements: "run with --hook by the PostToolUse hook after an edit of a rule or decision (BR-2404)",
  "work check-as": "run by the PreToolUse hook before each Bash call (BR-2343)",
  "work model": "run by the SessionStart and PostModelSwitch hooks (BR-2533)",
  "human record": "run by the PostToolUse hook of the question tool (BR-2274)",
  "snapshot take": "run with --hook by the PreToolUse hook before each Bash call",
  sync: "run by canon's git hook and after each landing",
  init: "a person sets canon up in a repository; the README says how",
  install: "a person installs canon's files into a repository",
  uninstall: "a person removes canon from a repository",
  "rule list": "a listing; canon search and canon context, which the guide names, find the same rules",
  "note list": "a listing; canon search, which the guide names, finds the same notes",
  "feature list": "a listing; canon overview and canon release status show the features of the releases in progress",
  "release list": "a listing; canon overview, which the brief points to, shows the releases in progress",
  "doc new": "only for document types a project declares under types:, which that project's own instructions introduce",
  "doc list": "only for document types a project declares under types:, which that project's own instructions introduce",
  "verdict pending": "a person's list: human verdicts on review findings are recorded outside Claude Code sessions (canon verdict record)",
};

/** Every runnable command of the tree, by the words that name it. */
function leaves(cmd: CommandDef<ArgsDef>, path: string[] = []): string[] {
  const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef<ArgsDef>>;
  const here = cmd.run && path.length > 0 ? [path.join(" ")] : [];
  return [...here, ...Object.entries(subs).flatMap(([name, sub]) => leaves(sub, [...path, name]))];
}

const files = (pattern: string, cwd: string): string[] => [...new Bun.Glob(pattern).scanSync({ cwd })].map((f) => join(cwd, f));
const code = files("**/*.ts", SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith("testkit.ts"));
const guides = code.filter((f) => f.endsWith("/guide.ts"));
const skills = files(".claude/skills/canon-*/**/*.md", ROOT);
// reason: a comment describes code to its reader, never to an agent running canon, so only strings and skill text count
const uncommented = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const text = new Map([...code.map((f) => [f, uncommented(readFileSync(f, "utf8"))] as const), ...skills.map((f) => [f, readFileSync(f, "utf8")] as const)]);

/** The file that registers a command: the commands.ts holding `entry("<name>", <rank>, ..., "<group>")` or the top-level entry. */
function home(path: string): string | undefined {
  const words = path.split(" ");
  const name = words.at(-1)!;
  const under = words.length > 1 ? words[0] : undefined;
  const entry = new RegExp(`entry\\("${name}",\\s*[\\d.]+,\\s*\\w+${under ? `,\\s*"${under}"` : "\\s*\\)"}`);
  // reason: a top-level command may carry its own subcommands (`canon rule new`), registered once as `entry("rule", ...)`
  const top = new RegExp(`entry\\("${words[0]}",\\s*[\\d.]+,\\s*\\w+\\s*\\)`);
  const file = code.find((f) => entry.test(text.get(f)!)) ?? code.find((f) => top.test(text.get(f)!));
  return file;
}

/**
 * Where `canon <path>` is named for an agent: a guide, a shipped skill, or the output of code other than the command's
 * own: the file that registers it and the file named after it (`adopt.ts` for `canon work adopt`) only describe it.
 */
function guidance(path: string): string[] {
  const words = `canon ${path}`;
  const own = home(path);
  const named = (f: string) => {
    const t = text.get(f)!;
    const at = t.indexOf(words);
    // reason: `canon work take` names `canon work take` but not `canon work takeover`; the next character must end the word
    return at >= 0 && !/[a-z-]/.test(t[at + words.length] ?? "");
  };
  return [
    ...guides.filter(named).map((f) => `guide ${relative(ROOT, f)}`),
    ...skills.filter(named).map((f) => `skill ${relative(ROOT, f)}`),
    ...code.filter((f) => !f.endsWith("/guide.ts") && f !== own && basename(f) !== `${path.split(" ").at(-1)}.ts` && named(f)).map((f) => `output ${relative(ROOT, f)}`),
  ];
}

describe("every command is led to", () => {
  const all = leaves(main);

  test("BR-2648: the walk finds the commands and the home of each, so the check below checks something", () => {
    expect(all.length).toBeGreaterThan(80);
    expect(all).toContain("work adopt");
    const homeless = all.filter((p) => home(p) === undefined);
    expect(homeless).toEqual([]);
  });

  test("BR-2648: every command an agent runs is named in a guide, a shipped skill or another domain's output; the rest are exempt with a reason", () => {
    const unguided = all.filter((p) => !(p in EXEMPT) && guidance(p).length === 0);
    expect(unguided).toEqual([]);
  });

  test("BR-2648: an exemption names a command that exists, and is dropped once the command is led to anyway", () => {
    expect(Object.keys(EXEMPT).filter((p) => !all.includes(p))).toEqual([]);
    // reason: hook commands are named by the installer that writes the hook; that is configuration, not guidance
    const hooked = new Set(["goal check", "restatements", "work check-as", "work model", "human record", "snapshot take", "sync", "init", "install", "uninstall"]);
    expect(Object.keys(EXEMPT).filter((p) => !hooked.has(p) && guidance(p).length > 0)).toEqual([]);
  });
});
