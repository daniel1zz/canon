import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew } from "../../../work/testkit.ts";
import { addedLines } from "./restatement.ts";

// reason: these tests drive the canon CLI through spawned processes and make worktrees (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../../invocation/main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const B1 = id("BR", 1);
const B2 = id("BR", 2);

const STATEMENT = "退款在七个工作日内原路退回到付款账户";
const rule = (n: number, statement: string, status = "active", examples = "- a → b") =>
  `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nstatus: ${status}\nuntested: fixture\nbusiness: x\n---\n\n## 规则\n\n${statement}\n\n## 例子\n\n${examples}\n`;
const decision = (n: number, body: string) =>
  `---\nid: ${id("D", n)}\ntitle: D${n}\nstatus: accepted\n---\n\n## 背景\n\n${body}\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA\n\n## 后果\n\nx\n`;
const README = "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n";

function canon(cwd: string, args: string[], stdin?: string) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** A project whose billing domain holds BR-1 (the statement) and BR-2 (with `second` as its statement). */
function billing(second: string, extra: Record<string, string> = {}): string {
  const root = project();
  write(root, { "canon/rules/billing/README.md": README, [`canon/rules/billing/${B1}.md`]: rule(1, STATEMENT), [`canon/rules/billing/${B2}.md`]: rule(2, second), "src/billing/.keep": "", ...extra });
  return root;
}

const list = (root: string) => canon(root, ["restatements"]);

describe("canon restatements", () => {
  test("BR-2401: a sentence that names a rule and copies its statement is listed with the shared runs, one line per finding, then the count; exit 0", () => {
    const root = billing(`退款按 ${B1} 在七个工作日内原路退回到付款账户。`);
    const r = list(root);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `canon/rules/billing/${B2}.md:11: ${B2} restates ${B1} (13 runs shared with its 规则 section): "退款按 ${B1} 在七个工作日内原路退回到付款账户。"; keep what ${B2} adds and name ${B1} for the rest`,
      "1 restatement(s) in 1 document(s)",
      "",
    ]);
    const j = canon(root, ["restatements", "--json"]);
    expect(JSON.parse(j.out)).toEqual([{ path: `canon/rules/billing/${B2}.md`, line: 11, id: B2, cited: B1, shared: 13, sentence: `退款按 ${B1} 在七个工作日内原路退回到付款账户。` }]);
  });

  test("BR-2401: 9 shared runs (12 characters copied) are not a restatement; 10 (13 characters) are", () => {
    expect(list(billing(`另外按 ${B1} 在七个工作日内原路退回到。`)).out).toBe("no restatements\n");
    expect(list(billing(`另外按 ${B1} 在七个工作日内原路退回到付。`)).out).toContain(`${B2} restates ${B1} (10 runs shared`);
  });

  test("BR-2401: a copy that names no rule, a source line, a retired rule, and a sentence in the examples are not listed", () => {
    expect(list(billing(`退款在七个工作日内原路退回到付款账户。`)).out).toBe("no restatements\n");
    const src = billing("x。", { "canon/decisions/D-1.md": decision(1, `背景。\n\n- 来源：canon/rules/billing/${B1}.md “${STATEMENT}”`) });
    expect(list(src).out).toBe("no restatements\n");
    const retired = billing(`退款按 ${B1} 在七个工作日内原路退回到付款账户。`);
    write(retired, { [`canon/rules/billing/${B1}.md`]: rule(1, STATEMENT, "retired") });
    expect(list(retired).out).toBe("no restatements\n");
    const examples = project();
    write(examples, { "canon/rules/billing/README.md": README, [`canon/rules/billing/${B1}.md`]: rule(1, STATEMENT), [`canon/rules/billing/${B2}.md`]: rule(2, "x。", "active", `- 退款按 ${B1} 在七个工作日内原路退回到付款账户 → b`), "src/billing/.keep": "" });
    const r = list(examples);
    expect([r.code, r.out]).toEqual([0, "no restatements\n"]);
    expect(JSON.parse(canon(examples, ["restatements", "--json"]).out)).toEqual([]);
  });

  test("BR-2401: with 40 rules a run in 4 rules besides the cited and the restating one is common and not counted; in 3 it counts", () => {
    const many = (k: number) => {
      const files: Record<string, string> = {};
      for (let n = 3; n <= 40; n++) files[`canon/rules/billing/${id("BR", n)}.md`] = rule(n, n - 2 <= k ? `规则 ${n} 也写：${STATEMENT}。` : `规则 ${n}。`);
      return billing(`退款按 ${B1} 在七个工作日内原路退回到付款账户。`, files);
    };
    expect(list(many(4)).out).toBe("no restatements\n");
    expect(list(many(3)).out).toContain(`${B2} restates ${B1} (13 runs shared`);
  });

  test("BR-2401: a decision's body is checked, and wrapped lines of one paragraph are one sentence", () => {
    const root = billing("x。", { "canon/decisions/D-1.md": decision(1, `我们按 ${B1} 在七个工作日\n内原路退回到付款账户。`) });
    expect(list(root).out).toContain(`canon/decisions/D-1.md:9: D-1 restates ${B1} (13 runs shared`);
  });
});

describe("new lines", () => {
  test("BR-2402: lines not in the base are new, equal lines cancel one for one, and without a base every line is new", () => {
    expect([...addedLines("a\nb\na\n", "a\nb\n")]).toEqual([3]);
    expect([...addedLines("a\nc\n", "a\nb\n")]).toEqual([2]);
    expect([...addedLines("a\nb", undefined)]).toEqual([1, 2]);
  });
});

/** A project with BR-1 and BR-2 on main, a change's worktree, and `edit` applied to BR-2 there. */
function inWorktree(second: string, edit: (text: string) => string) {
  const root = billing(second);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "rules");
  const wt = startNew(root, "edit rules").worktree;
  const file = join(wt, `canon/rules/billing/${B2}.md`);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  return { root, wt, file };
}

const COPY = `退款按 ${B1} 在七个工作日内原路退回到付款账户。`;
const hookInput = (file: string) => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, cwd: "/" });

describe("canon restatements --hook", () => {
  test("BR-2402: a restatement written into a rule's new lines comes back as PostToolUse additional context", () => {
    const { wt, file } = inWorktree("x。", (t) => t.replace("x。", `x。\n${COPY}`));
    const r = canon(wt, ["restatements", "--hook"], hookInput(file));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(`${B2} restates ${B1}`);
    expect(out.hookSpecificOutput.additionalContext).toContain("the rule review after landing records one in added lines as a blocking finding when it disagrees with the rule it copies, else as a note (BR-2405)");
  });

  test("BR-2402: a restatement already on main, with only the examples edited, says nothing about restatements", () => {
    const { wt, file } = inWorktree(COPY, (t) => t.replace("- a → b", "- a → c"));
    const r = canon(wt, ["restatements", "--hook"], hookInput(file));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("restates");
  });

  test("BR-2402: a new decision's every line is new", () => {
    const { wt } = inWorktree("x。", (t) => t);
    const file = join(wt, "canon/decisions/D-5.md");
    write(wt, { "canon/decisions/D-5.md": decision(5, COPY) });
    expect(canon(wt, ["restatements", "--hook"], hookInput(file)).out).toContain(`D-5 restates ${B1}`);
  });

  test("BR-2402: a file that is not a rule or decision, or input that is not JSON, says nothing and exits 0", () => {
    const { wt } = inWorktree("x。", (t) => t);
    write(wt, { "src/a.ts": COPY });
    expect([canon(wt, ["restatements", "--hook"], hookInput(join(wt, "src/a.ts"))).code, canon(wt, ["restatements", "--hook"], hookInput(join(wt, "src/a.ts"))).out]).toEqual([0, ""]);
    const r = canon(wt, ["restatements", "--hook"], "not json");
    expect([r.code, r.out]).toEqual([0, ""]);
  });
});

describe("canon check restatement notes", () => {
  test("BR-2403: in a change's worktree a restatement in new lines is a note on stderr; stdout and the exit code stay", () => {
    const { wt } = inWorktree("x。", (t) => t.replace("x。", `x。\n${COPY}`));
    const r = canon(wt, ["check"]);
    expect(r.err).toContain(`note: canon/rules/billing/${B2}.md:12: ${B2} restates ${B1}`);
    expect(r.out).toMatch(/^ok: /);
    expect(r.code).toBe(0);
  });

  test("BR-2403: a restatement already on main, and the primary checkout, give no note", () => {
    const { wt } = inWorktree(COPY, (t) => t.replace("- a → b", "- a → c"));
    expect(canon(wt, ["check"]).err).not.toContain("restates");
    const root = billing(COPY);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "rules");
    write(root, { [`canon/rules/billing/${B2}.md`]: rule(2, `${COPY}\n${COPY.replace("。", "！")}`) });
    expect(canon(root, ["check"]).err).not.toContain("restates");
  });
});
