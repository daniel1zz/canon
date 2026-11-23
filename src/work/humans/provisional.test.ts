import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { agenda, dueList, type Readings } from "../reminders/agenda.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const CALM: Readings = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function canon(cwd: string, actor: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8" };
  delete env["CLAUDECODE"];
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function fixture() {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Art checks", "agent:s1");
  // released, so the questions decide its state (BR-2571)
  expect(canon(s.worktree, "agent:s1", "work", "stop", "--reason", "partial", "--next", "wait for the owner", "--release").code).toBe(0);
  return { root, ...s };
}
const askOn = (root: string, change: string, text: string): number => {
  const r = canon(root, "agent:s1", "human", "ask", text, "--change", change);
  expect(r.code).toBe(0);
  return Number(/question #(\d+)/.exec(r.out)![1]);
};
const count = (root: string, kind: string) => { const w = ws(root); try { return w.db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind)!.n; } finally { w.db.close(); } };
const due = (root: string) => { const w = ws(root, "agent:s1"); try { const a = agenda(w, { read: CALM }); if (!a.ok) throw new Error(a.error.message); return dueList(a.value); } finally { w.db.close(); } };

test("BR-2636 BR-2571: a provisional answer takes the change out of waiting-owner; the question stays pending with the answer, who gave it and why, and stays in the owner group", () => {
  const f = fixture();
  const q = askOn(f.root, f.change, "A7 转给 C-1070？");
  expect(canon(f.root, "agent:s1", "change", "list").out).toContain(`waiting-owner: #${q}`);
  const r = canon(f.root, "agent:s1", "human", "provisional", String(q), "A7 转给 C-1070", "--reason", "顾问和主会话一致：A7 不挡试玩");
  expect(r.code).toBe(0);
  expect(canon(f.root, "agent:s1", "change", "list").out).not.toContain("waiting-owner");
  const pending = canon(f.root, "agent:s1", "human", "pending").out;
  expect(pending).toContain(`#${q} `);
  expect(pending).toContain("→ provisional: A7 转给 C-1070 (agent:s1: 顾问和主会话一致：A7 不挡试玩); still the owner's to answer");
  const item = due(f.root).find((i) => i.key === `question:${q}`)!;
  expect(item.group).toBe("owner");
  expect(item.summary).toContain("[provisional: A7 转给 C-1070 by agent:s1]");
  expect(count(f.root, "human.provisional")).toBe(1);
});

test("BR-2636: refused, changing nothing: an owner approval and a worker (1), empty reason or answer and a bad number (2), unknown (3), answered, withdrawn or already provisional (5)", () => {
  const f = fixture();
  const approve = askOn(f.root, f.change, `approve ${f.change}: 看录像确认?`);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(approve), "批准", "--reason", "x").code).toBe(1);
  const q = askOn(f.root, f.change, "A6 怎么办？");
  expect(canon(f.root, "agent:s1:w1", "human", "provisional", String(q), "转出", "--reason", "x").code).toBe(1);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "转出", "--reason", "  ").code).toBe(2);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "  ", "--reason", "x").code).toBe(2);
  expect(canon(f.root, "agent:s1", "human", "provisional", "abc", "转出", "--reason", "x").code).toBe(2);
  expect(canon(f.root, "agent:s1", "human", "provisional", "999", "转出", "--reason", "x").code).toBe(3);
  expect(count(f.root, "human.provisional")).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "转出", "--reason", "x").code).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "留下", "--reason", "y").code).toBe(5);
  expect(canon(f.root, "agent:s1", "human", "pending").out).toContain("→ provisional: 转出 ");
  const answered = askOn(f.root, f.change, "A3 怎么办？");
  expect(canon(f.root, "agent:s1", "human", "answer", String(answered), "拉远", "--relayed", "拉远").code).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(answered), "拉远", "--reason", "x").code).toBe(5);
  const gone = askOn(f.root, f.change, "A4 怎么办？");
  expect(canon(f.root, "agent:s1", "human", "withdraw", String(gone), "--reason", "不用问了").code).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "provisional", String(gone), "x", "--reason", "x").code).toBe(5);
  expect(count(f.root, "human.provisional")).toBe(1);
});

test("BR-2636: the question a finding waits on for the owner's verdict takes no provisional answer", () => {
  const f = fixture();
  const q = askOn(f.root, f.change, "意见 #1 是真问题吗？");
  const w = ws(f.root);
  w.db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, opened_at, question) VALUES ('x', 'contradiction', '[]', '[]', 'x', 'C-1', 0, '2026-11-23T00:00:00Z', ?)").run(q);
  w.db.close();
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "是", "--reason", "x").code).toBe(1);
});

test("BR-2637: an owner answer that differs from the provisional one puts overturned:<n> in the judge group's second tier until it is handled; a same answer does not", () => {
  const f = fixture();
  const q = askOn(f.root, f.change, "A7 转给 C-1070？");
  expect(canon(f.root, "agent:s1", "human", "provisional", String(q), "转给 C-1070", "--reason", "x").code).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "answer", String(q), "留在这里改", "--relayed", "留在这里改").code).toBe(0);
  const item = due(f.root).find((i) => i.key === `overturned:${q}`)!;
  expect(item).toMatchObject({ group: "judge", tier: 1 });
  expect(item.summary).toBe(`question #${q} (${f.change}): the owner answered "留在这里改", the provisional answer was "转给 C-1070"`);
  expect(canon(f.root, "agent:s1", "work", "handled", `overturned:${q}`, "--not-doing", "nothing was built on it yet").code).toBe(0);
  expect(due(f.root).some((i) => i.key === `overturned:${q}`)).toBe(false);
  const same = askOn(f.root, f.change, "A6 转出？");
  expect(canon(f.root, "agent:s1", "human", "provisional", String(same), "转出", "--reason", "x").code).toBe(0);
  expect(canon(f.root, "agent:s1", "human", "answer", String(same), " 转出 ", "--relayed", "转出").code).toBe(0);
  expect(due(f.root).some((i) => i.key === `overturned:${same}`)).toBe(false);
  expect(count(f.root, "human.provisional.overturned")).toBe(1);
});
