import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project } from "../../work/testkit.ts";

const MAIN = join(import.meta.dir, "../../cli/main.ts");
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
