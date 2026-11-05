import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { behaviourHash } from "../../knowledge/documents/behaviour.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { project, sh } from "../testkit.ts";
import { executionStates } from "./state.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const br = (n: number) => ["BR", n].join("-");
const GREEN = ["refs", "canon", "green"].join("/");

const body = (n: number, example = `- in ${n} → out ${n}`) => `## 规则\n\nStatement ${n}.\n\n## 例子\n\n${example}\n`;
const ruleFile = (n: number, status = "active", example?: string) => `---\nid: ${br(n)}\ntitle: Rule ${n}\nstatus: ${status}\nuntested: fixture\n---\n${body(n, example)}`;
const change = (n: number, passes: Record<string, string>, status = "done", rules: string[] = []) =>
  `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: [${rules.join(", ")}]\n${Object.keys(passes).length ? `passes:\n${Object.entries(passes).map(([id, v]) => `  ${id}: "${v}"\n`).join("")}` : ""}---\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`;

function repo(files: Record<string, string>): string {
  const root = project();
  const all: Record<string, string> = {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "canon/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n\n## 术语\n\n- **会话**：登录\n",
    "src/billing/.keep": "",
    "src/auth/.keep": "",
    ...files,
  };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const h = (n: number, example?: string) => behaviourHash(body(n, example));
const states = (root: string, timing: "before" | "after") => Object.fromEntries(executionStates(root, readCorpus(root).corpus, timing));

describe("execution states (BR-2246)", () => {
  test("BR-2246: planned; passed by the highest-numbered change with the current hash; rerun after a changed example; retired not listed (floor_timing before)", () => {
    const root = repo({
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/rules/billing/${br(2)}.md`]: ruleFile(2, "planned"),
      [`canon/rules/billing/${br(3)}.md`]: ruleFile(3, "active", "- in 3 → out 33"),
      [`canon/rules/billing/${br(4)}.md`]: ruleFile(4, "retired"),
      "canon/changes/C-3.md": change(3, { [br(1)]: `${h(1)} test`, [br(3)]: `${h(3)} test` }),
      "canon/changes/C-7.md": change(7, { [br(1)]: `${h(1)} migration` }),
      "canon/changes/C-9.md": change(9, { [br(1)]: `${h(1)} test` }, "open"),
    });
    expect(states(root, "before")).toEqual({
      [br(1)]: { kind: "passed", change: "C-7" },
      [br(2)]: { kind: "planned" },
      [br(3)]: { kind: "rerun" },
    });
  });

  test("BR-2246: with floor_timing after a record counts only once refs/canon/green holds it; without the ref none counts", () => {
    const root = repo({ [`canon/rules/billing/${br(1)}.md`]: ruleFile(1), [`canon/rules/billing/${br(2)}.md`]: ruleFile(2) });
    expect(states(root, "after")).toEqual({ [br(1)]: { kind: "rerun" }, [br(2)]: { kind: "rerun" } });
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-7.md"), change(7, { [br(1)]: `${h(1)} test` }));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "C-7 closes");
    expect(states(root, "after")[br(1)]).toEqual({ kind: "waiting", change: "C-7" }); // no green ref yet
    sh(root, "update-ref", GREEN, "HEAD~1");
    expect(states(root, "after")[br(1)]).toEqual({ kind: "waiting", change: "C-7" }); // green is before C-7 closed
    expect(states(root, "before")[br(1)]).toEqual({ kind: "passed", change: "C-7" });
    sh(root, "update-ref", GREEN, "HEAD");
    expect(states(root, "after")[br(1)]).toEqual({ kind: "passed", change: "C-7" });
  });
});

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe("canon progress (BR-2247)", () => {
  const fixture = () =>
    repo({
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/rules/billing/${br(2)}.md`]: ruleFile(2, "planned"),
      [`canon/rules/billing/${br(12)}.md`]: ruleFile(12),
      "canon/changes/C-1.md": change(1, { [br(1)]: `${h(1)} test` }, "done", [br(1), br(2)]),
    });

  test("BR-2247: without a target, one counts line per domain and a total line", () => {
    const r = canon(fixture(), "progress");
    expect(r.code).toBe(0);
    expect(r.out).toBe("auth  规划中 0  已通过 0  待 main 测试 0  待重新执行 0\nbilling  规划中 1  已通过 1  待 main 测试 0  待重新执行 1\n合计  规划中 1  已通过 1  待 main 测试 0  待重新执行 1\n");
  });

  test("BR-2247: a domain target adds one line per non-empty state with ids, passed ones with their change", () => {
    const r = canon(fixture(), "progress", "billing");
    expect(r.out).toBe(`billing  规划中 1  已通过 1  待 main 测试 0  待重新执行 1\n  规划中: ${br(2)}\n  已通过: ${br(1)} (C-1)\n  待重新执行: ${br(12)}\n`);
  });

  test("BR-2247: a change target counts the rules in its rules:", () => {
    const r = canon(fixture(), "progress", "C-1");
    expect(r.out).toBe(`C-1  规划中 1  已通过 1  待 main 测试 0  待重新执行 0\n  规划中: ${br(2)}\n  已通过: ${br(1)} (C-1)\n`);
  });

  test("BR-2247: a target that is neither a domain nor a change exits 3 with nothing on stdout", () => {
    const root = fixture();
    expect(canon(root, "progress", "nosuch")).toEqual({ code: 3, out: "" });
    expect(canon(root, "progress", "C-999")).toEqual({ code: 3, out: "" });
  });
});
