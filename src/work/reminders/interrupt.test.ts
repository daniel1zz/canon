import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { agenda, agendaLines, dueList, type Readings } from "./agenda.ts";
import type { Slots } from "./heavy.ts";

// reason: each case spawns canon or git several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const emptyQueue = () => mkdtempSync(join(tmpdir(), "canon-machine-"));
function cli(cwd: string, actor: string, args: readonly string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: emptyQueue() } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const machine = (load5: number): Readings => () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5, cpus: 8 } });
const CALM = machine(1);
const slots = (): Slots => ({ dir: emptyQueue(), gone: () => false });
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const changeDoc = (n: number, front = "", what = "x") => `---\nid: C-${n}\ntitle: Work ${n}\nstatus: open\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\n${what}\n`;
const ruleDoc = (id: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: active\nbusiness: x\nuntested: fixture\n---\n\n## 规则\n\nDo it.\n\n## 例子\n\n- Works.\n`;
function fresh(): string {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  return root;
}
function onMain(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
}
const withRules = (n: number, rules: string, what = "x") => changeDoc(n, "", what).replace("rules: []", `rules: [${rules}]`);

test("BR-2607: every change that can start is listed with both ways, a ready-self one with why it cannot be delegated, and the shared rules below it", () => {
  const root = fresh();
  onMain(root, { "canon/rules/x/BR-1.md": ruleDoc("BR-1"), "canon/changes/C-1.md": withRules(1, "BR-1"), "canon/changes/C-2.md": withRules(2, "BR-1"), "canon/changes/C-3.md": changeDoc(3, "", "") });
  expect(cli(root, "agent:s9", ["work", "start", "C-2"]).code).toBe(0);
  const lines = agendaLines(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots() })));
  expect(lines[0]).toBe("delegate: room for 10 more (load 1.0 of 16 on 8 CPUs, 0/10 slots); start or delegate: your call (D-156)");
  expect(lines[1]).toBe("  ready:C-1 P2 - Work 1 → canon work start C-1 | canon work delegate C-1 --to <name>");
  expect(lines[2]).toStartWith("    C-1 shares BR-1 with C-2 (claimed by agent:s9)");
  expect(lines[3]).toStartWith("  ready:C-3 P2 - Work 3 → canon work start C-3 (not delegatable: ");
  expect(lines.some((l) => l.includes("ready:C-2"))).toBe(false);
  const json = JSON.parse(cli(root, "agent:s1", ["work", "due", "--json"]).out) as { delegate: { changes: string[]; ready: { id: string; tier: string; delegatable: boolean; not_delegatable: string[]; facts: string[] }[] } };
  expect(json.delegate.changes).toEqual(["C-1"]);
  expect(json.delegate.ready.map((r) => [r.id, r.tier, r.delegatable])).toEqual([["C-1", "P2", true], ["C-3", "P2", false]]);
  expect(json.delegate.ready[0]!.facts[0]).toStartWith("C-1 shares BR-1 with C-2");
  expect(json.delegate.ready[1]!.not_delegatable.length).toBeGreaterThan(0);
});

test("BR-2607: with the machine busy the head says why and both ways are still listed; with nothing that can start there is no group", () => {
  const root = fresh();
  onMain(root, { "canon/changes/C-1.md": changeDoc(1) });
  const busy = agendaLines(must(agenda(ws(root, "agent:s1"), { read: machine(16), slots: slots() })));
  expect(busy[0]).toBe("delegate: busy (5-minute load 16.0 on 8 CPUs (limit 16)); start or delegate: your call (D-156)");
  expect(busy[1]).toBe("  ready:C-1 P2 - Work 1 → canon work start C-1 | canon work delegate C-1 --to <name>");
  expect(cli(root, "agent:s1", ["work", "start", "C-1"]).code).toBe(0);
  expect(agendaLines(must(agenda(ws(root, "agent:s1"), { read: machine(16), slots: slots() }))).some((l) => l.startsWith("delegate:"))).toBe(false);
});

test("BR-2606: a P0 or P1 change nobody works on is an interrupt item with the facts and both ways; P2 is not; a claim ends it", () => {
  const root = fresh();
  onMain(root, { "canon/changes/C-1.md": changeDoc(1), "canon/changes/C-2.md": changeDoc(2), "canon/changes/C-3.md": changeDoc(3), "canon/changes/C-4.md": changeDoc(4, "", "") });
  expect(cli(root, "agent:s1", ["priority", "set", "C-1", "P0", "--relayed", "这个最急"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["priority", "set", "C-2", "P1", "--reason", "blocks C-3"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["priority", "set", "C-4", "P1", "--reason", "needed soon"]).code).toBe(0);
  const s = startNew(root, "Mine", "agent:s1");
  const items = dueList(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots() })));
  const one = items.find((i) => i.key === "interrupt:C-1")!;
  expect(one).toMatchObject({ group: "judge", tier: 0, fixOnly: true });
  expect(one.summary).toBe(`P0 Work 1: nobody works on it; room for 10 more (load 1.0 of 16 on 8 CPUs, 0/10 slots); you hold ${s.change} P2`);
  expect(one.next).toBe(`canon work delegate C-1 --to <name>, or stop one of yours (canon work stop --reason partial --next "<next>") and canon work start C-1`);
  expect(items.find((i) => i.key === "interrupt:C-2")?.fixOnly).toBe(false);
  expect(items.find((i) => i.key === "interrupt:C-4")!.next).toStartWith(`stop one of yours (canon work stop --reason partial --next "<next>") and canon work start C-4 (not delegatable: `);
  expect(items.some((i) => i.key === "interrupt:C-3")).toBe(false);
  const due = cli(root, "agent:s1", ["work", "due"]).out;
  expect(due).toMatch(/judge: \d+\n {2}interrupt ×3 /);
  expect(cli(root, "agent:s2", ["work", "start", "C-1"]).code).toBe(0);
  expect(dueList(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots() }))).some((i) => i.key === "interrupt:C-1")).toBe(false);
});

test("BR-2606 BR-2583: a P0 interrupt cannot be deferred or dropped; a P1 one can", () => {
  const root = fresh();
  onMain(root, { "canon/changes/C-1.md": changeDoc(1), "canon/changes/C-2.md": changeDoc(2) });
  expect(cli(root, "agent:s1", ["priority", "set", "C-1", "P0", "--relayed", "这个最急"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["priority", "set", "C-2", "P1", "--reason", "soon"]).code).toBe(0);
  const p0 = cli(root, "agent:s1", ["work", "handled", "interrupt:C-1", "--defer", "x", "--for", "1h"]);
  expect(p0.code).toBe(1);
  expect(p0.err).toContain("a P0 change must be done now");
  expect(cli(root, "agent:s1", ["work", "handled", "interrupt:C-1", "--not-doing", "x"]).code).toBe(1);
  expect(cli(root, "agent:s1", ["work", "handled", "interrupt:C-2", "--defer", "x", "--for", "1h"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["work", "due"]).out).not.toContain("interrupt:C-2");
});

test("BR-2606 BR-2527: a P1 change whose delegation stalled is one interrupt item, not also a stalled one; a P2 one stays stalled", () => {
  const root = fresh();
  const a = startNew(root, "Urgent delegated", "agent:s1");
  const b = startNew(root, "Normal delegated", "agent:s1");
  for (const c of [a, b]) {
    sh(c.worktree, "commit", "-q", "--allow-empty", "-m", "design");
    expect(cli(root, "agent:s1", ["work", "delegate", c.change, "--to", `w${c.change}`]).code).toBe(0);
  }
  expect(cli(root, "agent:s1", ["priority", "set", a.change, "P1", "--reason", "soon"]).code).toBe(0);
  const later = Date.now() + 2 * 3_600_000;
  const keys = dueList(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots(), now: later }))).map((i) => i.key);
  expect(keys).toContain(`interrupt:${a.change}`);
  expect(keys).not.toContain(`stalled:${a.change}`);
  expect(keys).toContain(`stalled:${b.change}`);
  expect(keys).not.toContain(`interrupt:${b.change}`);
  const item = dueList(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots(), now: later }))).find((i) => i.key === `interrupt:${a.change}`)!;
  expect(item.summary).toContain(`delegated to w${a.change}, stalled`);
  expect(item.next).toBe(`canon work delegate ${a.change} --to <name> again, or canon work take ${a.change}`);
});

test("BR-2606: a worker's agenda has no interrupt item", () => {
  const root = fresh();
  onMain(root, { "canon/changes/C-1.md": changeDoc(1) });
  expect(cli(root, "agent:s1", ["priority", "set", "C-1", "P0", "--relayed", "这个最急"]).code).toBe(0);
  expect(dueList(must(agenda(ws(root, "agent:s1:w1"), { read: CALM, slots: slots() }))).some((i) => i.kind === "interrupt")).toBe(false);
});

test("BR-2607 BR-2614: a delegatable change whose text names a planned rule missing from rules: has that fact under it", () => {
  const root = fresh();
  onMain(root, { "canon/rules/x/BR-2.md": ruleDoc("BR-2").replace("status: active", "status: planned").replace("untested: fixture\n", ""), "canon/changes/C-1.md": changeDoc(1, "", "- BR-2 的加载检查") });
  const lines = agendaLines(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots() })));
  expect(lines[1]).toStartWith("  ready:C-1 P2 - Work 1 → canon work start C-1 | canon work delegate C-1 --to <name>");
  expect(lines[2]).toStartWith("    not in rules: BR-2 is planned and named in C-1's text");
});
