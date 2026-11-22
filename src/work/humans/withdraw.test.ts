import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { agenda, dueList } from "../reminders/agenda.ts";
import { approvalOf } from "../land/owner-gate.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
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
  return root;
}
const askOn = (root: string, change: string, text: string): number => {
  const r = canon(root, "agent:s1", "human", "ask", text, "--change", change);
  expect(r.code).toBe(0);
  return Number(/question #(\d+)/.exec(r.out)![1]);
};
const events = (root: string) => { const w = ws(root); try { return w.db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'human.withdraw'").get()!.n; } finally { w.db.close(); } };

test("BR-2628: canon human withdraw takes a superseded question out of pending and waiting-owner, keeps it in pending --all with its reason, and refuses a later answer with a human.answer.refuse event, reason withdrawn", () => {
  const root = fixture();
  const s = startNew(root, "Checks", "agent:s1");
  const old = askOn(root, s.change, "A7.2 看到了吗?");
  const later = askOn(root, s.change, "A7.2 现在看到了吗?");
  // released, so the questions decide its state (BR-2571)
  expect(canon(s.worktree, "agent:s1", "work", "stop", "--reason", "partial", "--next", "wait for the owner", "--release").code).toBe(0);
  expect(canon(root, "agent:s1", "change", "list").out).toContain(`waiting-owner: #${old}, #${later}`);
  const r = canon(root, "agent:s1", "human", "withdraw", String(old), "--superseded-by", `#${later}`, "--reason", "A7.2 改由新问题问");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`#${old} withdrawn (superseded by #${later}: A7.2 改由新问题问)`);
  const pending = canon(root, "agent:s1", "human", "pending").out;
  expect(pending).not.toContain(`#${old} `);
  expect(pending).toContain(`#${later} `);
  expect(canon(root, "agent:s1", "human", "pending", "--all").out).toContain(`→ withdrawn: superseded by #${later}: A7.2 改由新问题问`);
  expect(canon(root, "agent:s1", "human", "answer", String(later), "看到", "--relayed", "看到").code).toBe(0);
  expect(canon(root, "agent:s1", "change", "list").out).not.toContain("waiting-owner");
  const late = canon(root, "agent:s1", "human", "answer", String(old), "看到", "--relayed", "看到");
  expect(late.code).toBe(5);
  expect(late.out).toContain(`question #${old} was withdrawn (superseded by #${later}: A7.2 改由新问题问)`);
  expect(events(root)).toBe(1);
  const w = ws(root);
  try { expect(JSON.parse(w.db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'human.answer.refuse' ORDER BY id DESC LIMIT 1").get()!.detail)).toEqual({ reason: "withdrawn" }); } finally { w.db.close(); }
});

test("BR-2628: withdraw refuses an empty reason (2), a bad number (2), itself as its successor (2), an unknown question (3), an answered or withdrawn one (5) and a worker (1), recording nothing", () => {
  const root = fixture();
  const s = startNew(root, "Refusals", "agent:s1");
  const q = askOn(root, s.change, "要不要?");
  const done = askOn(root, s.change, "答过的?");
  expect(canon(root, "agent:s1", "human", "answer", String(done), "要", "--relayed", "要").code).toBe(0);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--reason", " ").code).toBe(2);
  expect(canon(root, "agent:s1", "human", "withdraw", "x", "--reason", "r").code).toBe(2);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--superseded-by", String(q), "--reason", "r").code).toBe(2);
  expect(canon(root, "agent:s1", "human", "withdraw", "999", "--reason", "r").code).toBe(3);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--superseded-by", "999", "--reason", "r").code).toBe(3);
  expect(canon(root, "agent:s1", "human", "withdraw", String(done), "--reason", "r").code).toBe(5);
  expect(canon(root, "agent:s1:w1", "human", "withdraw", String(q), "--reason", "r").code).toBe(1);
  expect(events(root)).toBe(0);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--reason", "不需要了").code).toBe(0);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--reason", "again").code).toBe(5);
  expect(events(root)).toBe(1);
});

test("BR-2628 BR-2527 BR-2617: a withdrawn question leaves the agenda's owner group, and a withdrawn approve question is no longer the one the owner-gate item waits for", () => {
  const root = fixture();
  const s = startNew(root, "Gated", "agent:s1");
  const q = askOn(root, s.change, `approve ${s.change}: 设计稿?`);
  const ownerKeys = () => { const a = agenda(ws(root, "agent:s1"), { read: () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } }) }); if (!a.ok) throw new Error(a.error.message); return dueList(a.value).map((i) => i.key); };
  expect(ownerKeys()).toContain(`question:${q}`);
  expect(approvalOf(ws(root).db, s.change, "设计稿").pending).toBe(q);
  expect(canon(root, "agent:s1", "human", "withdraw", String(q), "--reason", "设计稿还没好，好了再问").code).toBe(0);
  expect(ownerKeys()).not.toContain(`question:${q}`);
  expect(approvalOf(ws(root).db, s.change, "设计稿").pending).toBeUndefined();
});
