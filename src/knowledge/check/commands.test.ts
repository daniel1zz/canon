import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { project } from "../../work/testkit.ts";

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const readme = (code = "src/billing") => `---\ncode: [${code}]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n`;
const rule = (n: number) => `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nuntested: fixture\n---\n## 规则\n\nx.\n\n## 例子\n\n- a → b\n`;
const decision = (n: number, extra: string) =>
  `---\nid: ${id("D", n)}\ntitle: D${n}\nstatus: proposed\n${extra}---\n## 背景\n\nx\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA\n\n## 后果\n\nx\n`;

/** A project with one billing domain, its code directory and one rule: canon check finds nothing. */
function clean(): string {
  const root = project();
  write(root, { "canon/rules/billing/README.md": readme(), [`canon/rules/billing/${id("BR", 1)}.md`]: rule(1), "src/billing/.keep": "" });
  return root;
}

describe("canon check output", () => {
  test("BR-2189: no finding prints only the ok line and exits 0; --json prints [] and exits 0", () => {
    const root = clean();
    const r = canon(root, "check");
    expect([r.code, r.out]).toEqual([0, "ok: 1 documents, 1 domains\n"]);
    const j = canon(root, "check", "--json");
    expect([j.code, JSON.parse(j.out)]).toEqual([0, []]);
  });

  test("BR-2189: each finding is one line with its kind padded to 18, then the count; --json prints only the array; both exit 1", () => {
    const root = clean();
    write(root, {
      "canon/backlog.md": `---\ntitle: 待办顺序\n---\n- ${id("C", 99)}\n`,
      "canon/rules/billing/sub/README.md": readme("src/billing"), // a subdomain README must not list `code` (BR-2117)
    });
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out.split("\n")).toEqual([
      `ref-dangling       canon/backlog.md:4: lists ${id("C", 99)}, which is not a change`,
      "domain-code-declared canon/rules/billing/sub/README.md: remove `code:` from the README: a subdomain is business only; its code is found through the top-level domain",
      "2 finding(s)",
      "",
    ]);
    const j = canon(root, "check", "--json");
    expect(j.code).toBe(1);
    const findings = JSON.parse(j.out) as Record<string, string>[];
    expect(findings.map((f) => Object.keys(f).sort())).toEqual([["message", "path", "rule"], ["message", "path", "rule"]]);
    expect(findings.map((f) => `${f["rule"]} ${f["path"]}`)).toEqual(["ref-dangling canon/backlog.md:4", "domain-code-declared canon/rules/billing/sub/README.md"]);
  });

  test("BR-2139: amends that is not a list, names no document, names a non-decision or the decision itself makes canon check exit 1", () => {
    for (const [amends, kind] of [
      [`amends: ${id("D", 9)}\n`, "file-invalid"],
      [`amends: [${id("D", 99)}]\n`, "ref-dangling"],
      [`amends: [${id("BR", 1)}]\n`, "amends-not-decision"],
      [`amends: [${id("D", 10)}]\n`, "amends-not-decision"],
    ] as const) {
      const root = clean();
      write(root, { [`canon/decisions/${id("D", 9)}.md`]: decision(9, ""), [`canon/decisions/${id("D", 10)}.md`]: decision(10, amends) });
      const r = canon(root, "check");
      expect([kind, r.code, r.out.split("\n")[0]!.split(/\s+/)[0]]).toEqual([kind, 1, kind]);
    }
    const ok = clean();
    write(ok, { [`canon/decisions/${id("D", 9)}.md`]: decision(9, ""), [`canon/decisions/${id("D", 10)}.md`]: decision(10, `amends: [${id("D", 9)}]\n`) });
    expect(canon(ok, "check").code).toBe(0);
  });

  test("BR-2230: supersedes naming a rule, a change or the decision itself is supersedes-not-decision; naming nothing is only ref-dangling", () => {
    const kinds = (supersedes: string) => {
      const root = clean();
      write(root, {
        [`canon/decisions/${id("D", 1)}.md`]: decision(1, ""),
        [`canon/changes/${id("C", 9)}.md`]: `---\nid: ${id("C", 9)}\ntitle: C\nstatus: done\n---\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`,
        [`canon/decisions/${id("D", 2)}.md`]: decision(2, `supersedes: ${supersedes}\n`),
      });
      const r = canon(root, "check", "--json");
      return [r.code, (JSON.parse(r.out) as { rule: string }[]).map((f) => f.rule)];
    };
    expect(kinds(id("D", 1))).toEqual([0, []]);
    expect(kinds(id("C", 9))).toEqual([1, ["supersedes-not-decision"]]);
    expect(kinds(id("BR", 1))).toEqual([1, ["supersedes-not-decision"]]);
    expect(kinds(id("D", 2))).toEqual([1, ["supersedes-not-decision"]]);
    expect(kinds(id("D", 99))).toEqual([1, ["ref-dangling"]]);
    // reason: a list is read element by element, so each element gets the same checks (BR-2027)
    expect(kinds(`[${id("D", 1)}]`)).toEqual([0, []]);
    expect(kinds(`[${id("D", 1)}, ${id("C", 9)}]`)).toEqual([1, ["supersedes-not-decision"]]);
    expect(kinds(`[${id("D", 1)}, ${id("D", 99)}]`)).toEqual([1, ["ref-dangling"]]);
  });

  test("BR-2231: a file instructions lists that does not exist, or is a directory, is instructions-missing; the default CLAUDE.md is not checked", () => {
    const run = (instructions: string | undefined, files: Record<string, string>) => {
      const root = clean();
      write(root, files);
      if (instructions !== undefined) appendFileSync(join(root, "canon/config.yaml"), `instructions: ${instructions}\n`);
      const r = canon(root, "check");
      return [r.code, r.out.split("\n").filter((l) => l.startsWith("instructions-missing"))];
    };
    expect(run("[CLAUDE.md, docs/agent.md]", { "CLAUDE.md": "x", "docs/agent.md": "y" })).toEqual([0, []]);
    expect(run("[CLAUDE.md, docs/agent.md]", { "CLAUDE.md": "x" })).toEqual([
      1,
      ["instructions-missing canon/config.yaml: instructions lists docs/agent.md, which is not a file in the repository (BR-2231)"],
    ]);
    expect(run("[docs]", { "docs/agent.md": "y" })[0]).toBe(1);
    expect(run(undefined, {})).toEqual([0, []]);
  });
});

describe("canon check session text sizes", () => {
  const guideBytes = Buffer.byteLength(WORKFLOW_GUIDE, "utf8");
  const sizeLines = (err: string) => err.split("\n").filter((l) => l.startsWith("session-text "));
  const hintLines = (err: string) => err.split("\n").filter((l) => l.startsWith("hint session-text:"));
  const skill = (description?: string) => `---\nname: x\n${description === undefined ? "" : `description: ${description}\n`}---\n# x\n`;

  test("BR-2256: --sizes writes CLAUDE.md, the work guide, each skill description and the total to stderr; stdout and exit code unchanged", () => {
    const root = clean();
    write(root, { "CLAUDE.md": "x".repeat(2063), ".claude/skills/a/SKILL.md": skill("做 A"), ".claude/skills/b/SKILL.md": skill() });
    const r = canon(root, "check", "--sizes");
    expect([r.code, r.out]).toEqual([0, "ok: 1 documents, 1 domains\n"]);
    expect(sizeLines(r.err)).toEqual([
      "session-text CLAUDE.md: 2063 bytes",
      `session-text work guide: ${guideBytes} bytes`,
      "session-text .claude/skills/a/SKILL.md description: 5 bytes",
      "session-text .claude/skills/b/SKILL.md description: 0 bytes (no description)",
      `session-text total: ${2063 + guideBytes + 5} bytes, no budget (session_text_budget)`,
    ]);
    expect(sizeLines(canon(root, "check").err)).toEqual([]);
  });

  test("BR-2256 BR-2090: the work guide counts the overview line when the project has canon/architecture.md", () => {
    const root = clean();
    write(root, { "canon/architecture.md": "---\ntitle: 架构总览\n---\n# 架构总览\n" });
    const line = Buffer.byteLength("- Read canon/architecture.md first.\n", "utf8");
    expect(sizeLines(canon(root, "check", "--sizes").err)).toContain(`session-text work guide: ${guideBytes + line} bytes`);
  });

  test("BR-2256: no CLAUDE.md has no line; a linked CLAUDE.md is not read; a budget is named; --json keeps stdout to the array", () => {
    const root = clean();
    write(root, { "AGENTS.md": "y".repeat(500), "canon/config.yaml": "tests: []\nsession_text_budget: 12000\n" });
    const none = canon(root, "check", "--sizes");
    expect(sizeLines(none.err)).toEqual([`session-text work guide: ${guideBytes} bytes`, `session-text total: ${guideBytes} bytes, budget 12000`]);
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    write(root, { "canon/backlog.md": `---\ntitle: 待办顺序\n---\n- ${id("C", 99)}\n` });
    const linked = canon(root, "check", "--sizes", "--json");
    expect(linked.code).toBe(1);
    expect((JSON.parse(linked.out) as unknown[]).length).toBe(1);
    expect(sizeLines(linked.err)[0]).toBe("session-text CLAUDE.md: 0 bytes (symbolic link, not read)");
  });

  test("BR-2257: a total over session_text_budget prints one hint on stderr; stdout, --json and the exit code stay as without it", () => {
    const root = clean();
    write(root, { "CLAUDE.md": "x".repeat(150), ".claude/skills/a/SKILL.md": skill("做 A"), "canon/config.yaml": `tests: []\nsession_text_budget: ${guideBytes + 100}\n` });
    const r = canon(root, "check");
    expect([r.code, r.out]).toEqual([0, "ok: 1 documents, 1 domains\n"]);
    expect(hintLines(r.err)).toEqual([
      `hint session-text: ${guideBytes + 155} bytes loaded every session, over session_text_budget ${guideBytes + 100} (CLAUDE.md 150, work guide ${guideBytes}, skill descriptions 5); canon check --sizes lists each part`,
    ]);
    const j = canon(root, "check", "--json");
    expect([j.code, JSON.parse(j.out), hintLines(j.err).length]).toEqual([0, [], 1]);
  });

  test("BR-2257: a total equal to the budget, or no budget, prints no hint", () => {
    const root = clean();
    write(root, { "CLAUDE.md": "x".repeat(150), "canon/config.yaml": `tests: []\nsession_text_budget: ${guideBytes + 150}\n` });
    expect(hintLines(canon(root, "check").err)).toEqual([]);
    write(root, { "CLAUDE.md": "x".repeat(100_000), "canon/config.yaml": "tests: []\nsession_text_budget: null\n" });
    expect(hintLines(canon(root, "check").err)).toEqual([]);
  });

  test("BR-2257: session_text_budget of 0, 1.5 or a string is a config error, exit 2, naming the key", () => {
    for (const v of ["0", "1.5", '"8KB"', "-3"]) {
      const root = clean();
      write(root, { "canon/config.yaml": `tests: []\nsession_text_budget: ${v}\n` });
      const r = canon(root, "check");
      expect([v, r.code]).toEqual([v, 2]);
      expect(r.out + r.err).toContain("session_text_budget");
    }
  });
});
