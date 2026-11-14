import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { project } from "./testkit.ts";

const MAIN = join(import.meta.dir, "../invocation/main.ts");
const host = (child?: string) => ({ ...process.env, CANON_ACTOR: "", CLAUDECODE: "", CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: child ?? "session-a" });
function cli(root: string, input: unknown, child: string | undefined, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: root, env: host(child), stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("BR-2340: Codex PreToolUse refuses a missing/wrong child identity, allows its own id and refuses --as on the main thread", () => {
  const root = project();
  const hook = (command: string, child?: string) => cli(root, { session_id: "session-a", cwd: root, tool_name: "Bash", tool_input: { command } }, child, "work", "check-as", "--hook", "--runtime", "codex");
  for (const command of ["canon work land", "canon work land --as sibling"]) {
    const r = hook(command, "child-1");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
  }
  expect(hook("canon work land --as child-1", "child-1").out).toBe("");
  expect(JSON.parse(hook("canon work land --as child-1").out).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(hook("echo harmless", "child-1").out).toBe("");
});

test("BR-2182: Codex's Bash snapshot includes the caller's claimed tree and excludes siblings", () => {
  const root = project();
  for (const child of ["child-1", "child-2"]) {
    const started = cli(root, {}, child, "work", "start", "--title", child, "--as", child);
    expect(started.code).toBe(0);
  }
  const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
  const claims = db.query<{ holder: string; worktree: string }, []>("SELECT holder, worktree FROM claims ORDER BY holder").all();
  db.close();
  for (const claim of claims) writeFileSync(join(claim.worktree, "app.txt"), `uncommitted ${claim.holder}\n`);
  const result = cli(root, { cwd: root, session_id: "session-a" }, "child-1", "snapshot", "take", "--hook", "--runtime", "codex");
  expect(result.code).toBe(0);
  expect(result.out).toBe("");
  for (const [i, claim] of claims.entries()) {
    const snapshots = cli(claim.worktree, {}, undefined, "snapshot", "list", "--json");
    expect(JSON.parse(snapshots.out).length).toBe(i === 0 ? 1 : 0);
    expect(readFileSync(join(claim.worktree, "app.txt"), "utf8")).toContain("uncommitted");
  }
});

test("BR-2275: Codex question ids map to original text, secret answers are omitted, malformed answers refuse", () => {
  const root = project();
  // Verified against Codex rust-v0.167.2 codex-rs/protocol/src/request_user_input.rs.
  const input = {
    session_id: "session-a", tool_name: "request_user_input", tool_use_id: "call-1",
    tool_input: { questions: [{ id: "ship", header: "Ship", question: "Ship it?" }, { id: "secret", header: "Key", question: "Credential?", isSecret: true }] },
    tool_response: { answers: { ship: { answers: ["yes", "Friday"] }, secret: { answers: ["never-persist-this"] } } },
  };
  const r = cli(root, input, undefined, "human", "record", "--runtime", "codex");
  expect(r.code).toBe(0);
  expect(r.out).toBe("");
  const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
  const row = db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM events WHERE kind = 'human.asked'").get()!;
  expect(row.actor).toBe("agent:codex-session-a");
  expect(JSON.parse(row.detail).questions).toEqual([{ question: "Ship it?", answer: "yes, Friday", note: null }, { question: "Credential?", answer: null, note: null }]);
  expect(row.detail).not.toContain("never-persist-this");
  for (const answers of [{ unknown: { answers: ["yes"] } }, { ship: { answers: "yes" } }]) {
    const bad = cli(root, { ...input, tool_response: { answers } }, undefined, "human", "record", "--runtime", "codex");
    expect(bad.code).toBe(2);
  }
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind='human.asked'").get()!.n).toBe(1);
  db.close();
});

test("BR-2402: a multi-file Codex apply_patch checks every edited rule and emits one context object", () => {
  const root = project();
  const id = (n: number) => ["BR", n].join("-");
  const rule = (n: number, text: string) => `---\nid: ${id(n)}\ntitle: Refund ${n}\nstatus: active\nuntested: fixture\nbusiness: refund\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "# Billing\n\n## 业务\n\n- **refund**：退款。\n");
  writeFileSync(join(root, `canon/rules/billing/${id(1)}.md`), rule(1, "退款在七个工作日内原路退回到付款账户。"));
  for (const n of [2, 3]) writeFileSync(join(root, `canon/rules/billing/${id(n)}.md`), rule(n, `退款按 ${id(1)} 在七个工作日内原路退回到付款账户。`));
  const patch = `*** Begin Patch\n*** Update File: canon/rules/billing/${id(2)}.md\n@@\n+new line\n*** Update File: canon/rules/billing/${id(3)}.md\n@@\n+new line\n*** End Patch`;
  const r = cli(root, { tool_name: "apply_patch", tool_input: { command: patch } }, undefined, "restatements", "--hook", "--runtime", "codex");
  expect(r.code).toBe(0);
  const context = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  expect(context).toContain(`${id(2)} restates ${id(1)}`);
  expect(context).toContain(`${id(3)} restates ${id(1)}`);
  const deleted = cli(root, { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Delete File: app.txt\n*** End Patch` } }, undefined, "restatements", "--hook", "--runtime", "codex");
  expect(deleted.code).toBe(0);
  expect(deleted.out).toBe("");
});


test("BR-2275: an empty native answer is null and a numeric answer is refused", () => {
  const root = project();
  const payload = { session_id: "session-a", tool_name: "request_user_input", tool_input: { questions: [{ id: "q", question: "Ship?" }] }, tool_response: { answers: { q: { answers: [] } } } };
  expect(cli(root, payload, undefined, "human", "record", "--runtime", "codex").code).toBe(0);
  const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
  const row = db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind='human.asked'").get()!;
  expect(JSON.parse(row.detail).questions[0].answer).toBeNull();
  const malformed = { ...payload, tool_response: { answers: { q: { answers: 1 } } } };
  expect(cli(root, malformed, undefined, "human", "record", "--runtime", "codex").code).toBe(2);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind='human.asked'").get()!.n).toBe(1);
  db.close();
});
