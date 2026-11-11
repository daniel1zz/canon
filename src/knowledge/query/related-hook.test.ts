import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh } from "../../work/testkit.ts";

// reason: these tests drive the canon CLI through spawned processes (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const BR = (n: number) => ["BR", n].join("-");
const rule = (n: number, body: string) => `---\nid: ${BR(n)}\ntitle: r${n}x\nstatus: active\nuntested: fixture\n---\n\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const README = "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n";
const STATEMENT = "退款在七个工作日内原路退回到付款账户";

function repo(files: Record<string, string>): string {
  const root = project();
  for (const [p, text] of Object.entries({ "canon/rules/billing/README.md": README, "src/billing/.keep": "", ...files })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "rules");
  return root;
}

/** The hook's additional context for an edit of `file`, or "" when it printed nothing. */
function hook(root: string, file: string): { code: number; context: string } {
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, file) }, cwd: "/" });
  const r = Bun.spawnSync(["bun", MAIN, "restatements", "--hook"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: Buffer.from(input), env: { ...process.env, CANON_ACTOR: "agent:test" } });
  const out = r.stdout.toString();
  return { code: r.exitCode, context: out === "" ? "" : (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext };
}

const one = `canon/rules/billing/${BR(1)}.md`;

describe("canon restatements --hook lists related documents", () => {
  test("BR-2421: after an edit of a rule another rule names, the hook lists it with its reason", () => {
    const root = repo({ [one]: rule(1, "退款时记账。"), [`canon/rules/billing/${BR(7)}.md`]: rule(7, `按 ${BR(1)} 发货。`) });
    const r = hook(root, one);
    expect(r.code).toBe(0);
    expect(r.context).toBe(`canon: the documents most related to ${BR(1)} (references both ways, shared text and names); check this edit does not contradict them:\n- ${BR(7)} r7x (names ${BR(1)})`);
  });

  test("BR-2421: with 8 related documents only 5 are listed", () => {
    const files: Record<string, string> = { [one]: rule(1, "退款时记账。") };
    for (let n = 10; n < 18; n++) files[`canon/rules/billing/${BR(n)}.md`] = rule(n, `按 ${BR(1)} 处理。`);
    expect(hook(repo(files), one).context.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
  });

  test("BR-2421: a restatement comes first, then a blank line, then the related documents, in one JSON line", () => {
    const root = repo({ [one]: rule(1, STATEMENT), [`canon/rules/billing/${BR(2)}.md`]: rule(2, "x。") });
    const file = `canon/rules/billing/${BR(2)}.md`;
    writeFileSync(join(root, file), rule(2, `x。\n退款按 ${BR(1)} 在七个工作日内原路退回到付款账户。`));
    const r = hook(root, file);
    const [restates, related] = r.context.split("\n\n");
    expect(restates).toContain(`${BR(2)} restates ${BR(1)}`);
    expect(related).toStartWith(`canon: the documents most related to ${BR(2)}`);
    expect(related).toContain(`- ${BR(1)} r1x (named by ${BR(2)}`);
  });

  test("BR-2421: a rule with nothing related and no restatement prints nothing; a file that is not a rule prints nothing", () => {
    const root = repo({ [one]: rule(1, "退款时记账。") });
    expect(hook(root, one)).toEqual({ code: 0, context: "" });
    expect(hook(root, "src/a.ts")).toEqual({ code: 0, context: "" });
  });
});
