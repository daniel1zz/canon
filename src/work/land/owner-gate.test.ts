import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { land } from "./land.ts";
import { approvalOf, gateRefusal } from "./owner-gate.ts";
import { agenda, dueList, type Readings } from "../reminders/agenda.ts";

// reason: each case lands or spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const CALM: Readings = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
function cli(cwd: string, actor: string, args: readonly string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}

/** A change agent:s1 holds whose file carries `owner_gate` (or `front` instead), committed on its branch. */
function gated(front = 'owner_gate: "设计稿"\n') {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Design draft", "agent:s1");
  const dir = join(s.worktree, "canon/changes");
  const path = join(dir, readdirSync(dir).find((p) => p.startsWith(`${s.change}-`) || p === `${s.change}.md`)!);
  // reason: startNew states owner_gate as none (BR-2620); this fixture replaces it with the gate under test
  writeFileSync(path, readFileSync(path, "utf8").replace(/owner_gate: .*\n/, "").replace("status: open\n", `status: open\n${front}`));
  writeFileSync(join(s.worktree, "draft.md"), "draft\n");
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "draft");
  return { root, ...s };
}
/** An answered question: by a human at a terminal unless `relayed` (then `witness`) or `by` say otherwise. */
function answered(root: string, question: string, answer: string, opts: { by?: string; relayed?: string; witness?: string } = {}) {
  const w = ws(root);
  const now = new Date().toISOString();
  w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, answer, answered_by, relayed, witness, asked_at, answered_at) VALUES (NULL, 'agent:s1', ?, '[\"批准\",\"不批准\"]', ?, ?, ?, ?, ?, ?)")
    .run(question, answer, opts.by ?? "human:dz", opts.relayed ?? null, opts.witness ?? null, now, now);
  w.db.close();
}
const finish = (wt: string, actor = "agent:s1") => land(ws(wt, actor), { ...FAST, finish: true }, quiet);

test("BR-2615: owner_gate is a non-empty text or none: <reason>; empty, not text or a none without reason is file-invalid", () => {
  for (const [front, bad] of [['owner_gate: "设计稿"\n', false], ['owner_gate: "none: 内部工具"\n', false], ['owner_gate: "  "\n', true], ["owner_gate: true\n", true], ['owner_gate: "none:"\n', true]] as const) {
    const f = gated(front);
    const r = cli(f.worktree, "agent:s1", ["check"]);
    expect(r.text.includes("`owner_gate` must be a non-empty text")).toBe(bad);
  }
});

test("BR-2615 BR-2623 BR-2616 BR-2617: owner_gate none: <reason> is no gate: no agenda item, and land --finish does not wait for the owner", async () => {
  const f = gated('owner_gate: "none: 内部工具"\n');
  expect(dueList(must(agenda(ws(f.root, "agent:s2"), { read: CALM }))).some((i) => i.key === `owner-gate:${f.change}`)).toBe(false);
  expect(await finish(f.worktree)).toMatchObject({ kind: "landed", finished: true });
});

test("BR-2616: land --finish waits for the owner's latest approve answer; the refusal names the gate, the latest question and answer (or not asked yet) and how to ask; a later no revokes; an agent's own answer does not count; without --finish it lands", async () => {
  const f = gated();
  const none = await finish(f.worktree);
  expect(none).toMatchObject({ kind: "refused", reason: "owner-gate" });
  expect(none.kind === "refused" && none.message).toContain("the owner has not been asked yet");
  expect(none.kind === "refused" && none.message).toContain(`canon human ask "approve ${f.change}: 设计稿?" --option 批准,不批准 --change ${f.change}`);
  answered(f.root, `approve ${f.change}0: other`, "批准");
  expect(await finish(f.worktree)).toMatchObject({ kind: "refused", reason: "owner-gate" });
  answered(f.root, `approve ${f.change}: 设计稿?`, "批准", { by: "agent:s1" });
  const agent = await finish(f.worktree);
  expect(agent.kind === "refused" && agent.message).toContain("not the owner's own answer");
  answered(f.root, `approve ${f.change}: 设计稿?`, "批准", { by: "agent:s1", relayed: "可以。", witness: "match" });
  answered(f.root, `approve ${f.change}: 设计稿?`, "不批准");
  const no = await finish(f.worktree);
  expect(no.kind === "refused" && no.message).toContain('answered "不批准"');
  expect(await land(ws(f.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "landed", finished: false });
  answered(f.root, `approve ${f.change}: 设计稿 v2?`, "可以。", { by: "agent:s1", relayed: "可以。", witness: "match" });
  expect(await finish(f.worktree)).toMatchObject({ kind: "landed", finished: true });
});

test("BR-2616: an approval is one of 批准 同意 可以 是 yes, any case, trimmed and without trailing punctuation; only a question naming the whole id counts", () => {
  const f = gated();
  const approved = () => approvalOf(ws(f.root).db, f.change).approved;
  for (const [answer, yes] of [[" 可以。", true], ["YES", true], ["同意！", true], ["批准了", false], ["不批准", false], ["是", true], ["好的", false]] as const) {
    answered(f.root, `approve ${f.change}: 设计稿?`, answer);
    expect([answer, approved()]).toEqual([answer, yes]);
  }
  answered(f.root, `approve ${f.change}: 设计稿?`, "不批准");
  answered(f.root, `approve ${f.change}0: other?`, "批准"); // C-n0 is another change: the latest answer for C-n is still 不批准
  expect(approved()).toBe(false);
});

test("BR-2616: a worker refused for the owner gate is told it cannot ask the owner and hands the change back", () => {
  const msg = gateRefusal(["C", 9].join("-"), "设计稿", { approved: false }, true);
  expect(msg).toContain("canon work stop --reason owner");
  expect(gateRefusal(["C", 9].join("-"), "设计稿", { approved: false }, false)).not.toContain("canon work stop --reason owner");
});

test("BR-2617: until approved the main session's agenda says to ask, then that it waits for the answer; approved, it is gone; a worker's agenda has no such item", () => {
  const f = gated();
  const item = () => dueList(must(agenda(ws(f.root, "agent:s2"), { read: CALM }))).find((i) => i.key === `owner-gate:${f.change}`);
  expect(item()!.summary).toBe(`${f.change} needs the owner's approval of: 设计稿; ask when it is ready to show`);
  expect(item()!.next).toBe(`canon human ask "approve ${f.change}: 设计稿?" --option 批准,不批准 --change ${f.change}`);
  expect(cli(f.worktree, "agent:s1", ["human", "ask", `approve ${f.change}: 设计稿?`, "--option", "批准,不批准", "--change", f.change]).code).toBe(0);
  expect(item()!.summary).toMatch(/waiting for the answer to question #\d+/);
  answered(f.root, `approve ${f.change}: 设计稿?`, "不批准");
  answered(f.root, `approve ${f.change}: 设计稿?`, "批准");
  expect(item()).toBeUndefined();
  expect(dueList(must(agenda(ws(f.root, "agent:s1:w1"), { read: CALM }))).some((i) => i.kind === "owner-gate")).toBe(false);
});

test("BR-2618: delegating a gated change not approved says the worker cannot finish it; approved, it does not", () => {
  const f = gated();
  expect(cli(f.worktree, "agent:s1", ["work", "stop", "--reason", "partial", "--next", "x", "--release"]).code).toBe(0);
  const r = cli(f.root, "agent:s1", ["work", "delegate", f.change, "--to", "w1"]);
  expect(r.code).toBe(0);
  expect(r.text).toContain(`owner gate: ${f.change} needs the owner's approval of "设计稿" before it can finish`);
  answered(f.root, `approve ${f.change}: 设计稿?`, "批准");
  const again = cli(f.root, "agent:s1", ["work", "delegate", f.change, "--to", "w1"]);
  expect(again.code).toBe(0);
  expect(again.text).not.toContain("owner gate:");
});
