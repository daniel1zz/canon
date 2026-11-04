import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { project, sh } from "../testkit.ts";
import { encodePath, projectsDir, readRecords, renderUsage, usageReport, type Places } from "./usage.ts";

// reason: the CLI cases spawn canon, which spawns git; under load a spawn can take seconds (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const AT: Places = { primary: "/w/p", worktrees: "/w/p.worktrees", canonDir: "/w/p/.git/canon" };
const NOW = new Date("2026-11-04T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A fabricated `projects` directory: each file is a list of records, written one JSON per line. */
function records(files: Record<string, (object | string)[]>): string {
  const projects = join(mkdtempSync(join(tmpdir(), "canon-usage-")), "projects");
  for (const [path, recs] of Object.entries(files)) {
    const full = join(projects, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  }
  return projects;
}

const toolUse = (ts: string, name: string, input: object, id = `toolu_${Math.random()}`) => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const command = (ts: string, name: string, uuid = `u-${Math.random()}`) => ({ type: "user", uuid, timestamp: ts, message: { role: "user", content: `<command-name>/${name}</command-name>\n<command-args></command-args>` } });
const attach = (ts: string, attachment: object) => ({ type: "attachment", timestamp: ts, attachment });
const listing = (ts: string, skills: Record<string, string>, isInitial = true) =>
  attach(ts, { type: "skill_listing", isInitial, names: Object.keys(skills), content: Object.entries(skills).map(([n, d]) => `- ${n}: ${d}`).join("\n") });

function report(projects: string, days = 30) {
  const r = usageReport(projects, AT, days, NOW);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const usesOf = (r: ReturnType<typeof report>, kind: string) => r.uses.filter((u) => u.kind === kind).map((u) => [u.name, u.uses, u.last]);

describe("canon usage counts", () => {
  test("BR-2265: Skill, mcp__ and Agent tool uses count by name with their latest time; a repeated tool_use id counts once", () => {
    const dup = toolUse(daysAgo(1), "Skill", { skill: "canon-design" }, "toolu_same");
    const projects = records({
      "-w-p/s1.jsonl": [
        toolUse(daysAgo(3), "Skill", { skill: "canon-design" }),
        dup,
        dup,
        toolUse(daysAgo(2), "mcp__serena__find_symbol", {}),
        toolUse(daysAgo(1), "mcp__serena__find_symbol", {}),
        toolUse(daysAgo(5), "mcp__serena__read_file", {}),
        toolUse(daysAgo(1), "Agent", { subagent_type: "Explore" }),
        toolUse(daysAgo(1), "Task", {}),
        toolUse(daysAgo(1), "Bash", { command: "ls" }),
      ],
    });
    const r = report(projects);
    expect(usesOf(r, "skill")).toEqual([["canon-design", 2, daysAgo(1)]]);
    expect(usesOf(r, "mcp")).toEqual([["serena", 3, daysAgo(1)]]);
    expect(usesOf(r, "agent")).toEqual([["(unspecified)", 1, daysAgo(1)], ["Explore", 1, daysAgo(1)]]);
  });

  test("BR-2265: a slash command counts only when it names a skill; a repeated user record counts once", () => {
    const again = command(daysAgo(1), "canon-design", "u-1");
    const projects = records({ "-w-p/s1.jsonl": [listing(daysAgo(1), { "canon-design": "d" }), again, again, command(daysAgo(1), "model")] });
    const r = report(projects);
    expect(usesOf(r, "skill")).toEqual([["canon-design", 1, daysAgo(1)]]);
  });

  test("BR-2265: reads the primary's, worktrees' and canon dir's directories and subagent records, not another project; bad lines are counted", () => {
    const use = (n: string) => toolUse(daysAgo(1), "Skill", { skill: n });
    const projects = records({
      "-w-p/s1.jsonl": [use("a"), "{not json"],
      "-w-p/s1/subagents/agent-x.jsonl": [use("b")],
      "-w-p-worktrees-C-1/s2.jsonl": [use("c")],
      "-w-p--git-canon-batch-3/s3.jsonl": [use("d")],
      "-w-px/s4.jsonl": [use("e")],
    });
    const r = report(projects);
    expect(r.uses.map((u) => u.name).sort()).toEqual(["a", "b", "c", "d"]);
    expect([r.dirs.length, r.files, r.skipped]).toEqual([3, 4, 1]);
    expect(renderUsage(r)).toStartWith(`session records: 4 file(s) in 3 project directories under ${projects}, 1 unreadable line(s) skipped`);
  });

  test("BR-2265: the records directory follows CLAUDE_CONFIG_DIR, else ~/.claude; the encoding replaces every non-alphanumeric character", () => {
    expect(projectsDir({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/projects");
    expect(projectsDir({ CLAUDE_CONFIG_DIR: "  " }).endsWith("/.claude/projects")).toBe(true);
    expect(encodePath("/Users/a/zz/canon.worktrees/C-1")).toBe("-Users-a-zz-canon-worktrees-C-1");
  });

  test("BR-2265: no directory of this project is not found (exit 3); the run changes no file of the records", () => {
    const empty = records({ "-w-px/s.jsonl": [toolUse(daysAgo(1), "Skill", { skill: "a" })] });
    const r = usageReport(empty, AT, 30, NOW);
    expect(!r.ok && r.error.code).toBe("not_found");

    const root = project();
    const config = mkdtempSync(join(tmpdir(), "canon-usage-cfg-"));
    const primary = sh(root, "rev-parse", "--show-toplevel").trim();
    const file = join(config, "projects", encodePath(primary), "s.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(listing(new Date().toISOString(), { a: "x" }))}\n`);
    const before = [readFileSync(file, "utf8"), statSync(file).mtimeMs];
    const run = (env: Record<string, string>, ...args: string[]) =>
      Bun.spawnSync([process.execPath, MAIN, "usage", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test", ...env } });
    const ok = run({ CLAUDE_CONFIG_DIR: config });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("  skill a");
    expect([readFileSync(file, "utf8"), statSync(file).mtimeMs]).toEqual(before);
    expect(readdirSync(dirname(file))).toEqual(["s.jsonl"]);
    expect(run({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "canon-usage-none-")) }).exitCode).toBe(3);
  });
});

describe("canon usage while records are removed", () => {
  test("BR-2265: a file or a directory deleted after it was listed is skipped, not a crash (issue #94)", () => {
    const use = (n: string) => toolUse(daysAgo(1), "Skill", { skill: n });
    const projects = records({ "-w-p/s1.jsonl": [use("a")], "-w-p/s2.jsonl": [use("b")], "-w-p-worktrees-C-1/s3.jsonl": [use("c")] });
    // reason: the first read deletes the other session file (already listed) and the worktree directory (listed, not yet read)
    let first = true;
    const read = (file: string) => {
      if (first) {
        first = false;
        rmSync(join(projects, "-w-p", file.endsWith("s1.jsonl") ? "s2.jsonl" : "s1.jsonl"));
        rmSync(join(projects, "-w-p-worktrees-C-1"), { recursive: true });
      }
      return readRecords(file);
    };
    const r = usageReport(projects, AT, 30, NOW, read);
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.files, r.value.uses.length, r.value.dirs.length]).toEqual([1, 1, 2]);
    expect(readRecords(join(projects, "nothing.jsonl"))).toBeUndefined();
  });
});

describe("canon usage unused", () => {
  test("BR-2266: an available item not used in the window is listed with its size, last use and last injection, largest first", () => {
    const projects = records({
      "-w-p/s1.jsonl": [listing(daysAgo(1), { a: "short", b: "a longer description" }), toolUse(daysAgo(1), "Skill", { skill: "a" }), toolUse(daysAgo(40), "Skill", { skill: "b" })],
    });
    const r30 = report(projects, 30);
    expect(r30.unused.map((u) => [u.kind, u.name, u.size, u.last, u.injected])).toEqual([["skill", "b", "- b: a longer description".length, daysAgo(40), daysAgo(1)]]);
    expect(renderUsage(r30)).toContain("total: 1 item(s), 25 characters");
    expect(report(projects, 60).unused).toEqual([]);
  });

  test("BR-2266: the available list is the union of the window's sessions; a later partial listing adds; an old session's item is gone", () => {
    const projects = records({
      "-w-p/old.jsonl": [listing(daysAgo(50), { old: "o" })],
      "-w-p/s1.jsonl": [
        attach(daysAgo(10), { type: "mcp_instructions_delta", addedNames: ["serena"], addedBlocks: ["x".repeat(120)], removedNames: [] }),
        attach(daysAgo(10), { type: "deferred_tools_delta", addedNames: ["Monitor", "mcp__serena__a", "mcp__serena__bb"], removedNames: [] }),
        attach(daysAgo(10), { type: "agent_listing_delta", isInitial: true, addedTypes: ["Plan"], addedLines: ["- Plan: plans"], removedTypes: [] }),
        listing(daysAgo(10), { a: "x" }),
      ],
      "-w-p/s2.jsonl": [listing(daysAgo(1), { a: "x" }), listing(daysAgo(1), { c: "y" }, false)],
    });
    const r = report(projects);
    expect(r.unused.map((u) => [u.kind, u.name, u.size, u.injected])).toEqual([
      ["mcp", "serena", 151, daysAgo(10)],
      ["agent", "Plan", 13, daysAgo(10)],
      ["skill", "a", 6, daysAgo(1)],
      ["skill", "c", 6, daysAgo(1)],
    ]);
  });

  test("BR-2266: a server removed later in the session is not available; MCP names match tool names; subagent listings are not used", () => {
    const projects = records({
      "-w-p/s1.jsonl": [
        listing(daysAgo(2), { a: "x" }),
        attach(daysAgo(2), { type: "mcp_instructions_delta", addedNames: ["serena", "claude.ai Linear"], addedBlocks: ["s", "l"], removedNames: [] }),
        attach(daysAgo(2), { type: "deferred_tools_delta", addedNames: ["mcp__serena__a", "mcp__claude_ai_Linear__t"], removedNames: [] }),
        attach(daysAgo(1), { type: "mcp_instructions_delta", addedNames: [], addedBlocks: [], removedNames: ["serena"] }),
        attach(daysAgo(1), { type: "deferred_tools_delta", addedNames: [], removedNames: ["mcp__serena__a"] }),
        toolUse(daysAgo(1), "mcp__claude_ai_Linear__t", {}),
      ],
      "-w-p/s1/subagents/agent-x.jsonl": [listing(daysAgo(0.5), { sub: "z" })],
    });
    const r = report(projects);
    expect(r.available.map((a) => `${a.kind}:${a.name}`).sort()).toEqual(["mcp:claude_ai_Linear", "skill:a"]);
    expect(r.unused.map((u) => u.name)).toEqual(["a"]);
  });

  test("BR-2266: without a skill listing in the window nothing is called unused; --days must be a whole number of 1 or more", () => {
    const projects = records({ "-w-p/s1.jsonl": [toolUse(daysAgo(1), "Skill", { skill: "a" })] });
    const r = report(projects);
    expect(r.unused).toEqual([]);
    expect(renderUsage(r)).toContain("no listing of available skills found");

    const root = project();
    for (const bad of ["0", "x", "1.5"]) {
      const p = Bun.spawnSync([process.execPath, MAIN, "usage", "--days", bad], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
      expect(p.exitCode).toBe(2);
    }
  });
});
