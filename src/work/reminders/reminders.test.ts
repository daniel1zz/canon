import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import type { Workspace } from "../workspace.ts";
import { age, renderDue } from "./due.ts";
import { agenda, agendaJson, agendaLines, dueItems, summary, type Readings } from "./agenda.ts";
import { runningFullRuns, type Loads, type Slots } from "./heavy.ts";
import { roomOf } from "./room.ts";
import { holds } from "./handled.ts";
import { watchDue, RECOMPUTE_MS } from "./watch.ts";
import { lastEventId } from "../stats/window.ts";
import { behaviourHash } from "../../knowledge/documents/behaviour.ts";

// reason: each case spawns canon or git several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, args: readonly string[], extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: emptyQueue(), ...extra } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const machine = (load5: number, tight = false): Readings => () => ({ memory: { tight, text: tight ? "memory pressure warn" : "memory pressure normal" }, machine: { load5, cpus: 8 } });
const CALM = machine(1);
function fresh(): string {
  const root = project(); roots.push(root);
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  return root;
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function finding(w: Workspace, minutes: number, tier: string | null = null, criterion = "contradiction", ids: readonly string[] = ["BR-1"]): number {
  return Number(w.db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at, tier) VALUES (?, ?, ?, ?, 'x contradicts y', 'C-9', 1, 'abc', ?, ?)").run(`id-${Math.random()}`, criterion, JSON.stringify(ids), JSON.stringify(ids), minutesAgo(minutes), tier).lastInsertRowid);
}
const changeDoc = (n: number, status = "open", front = "") => `---\nid: C-${n}\ntitle: Work ${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;
/** Change files committed on main: each ready to delegate unless its front matter says otherwise. */
function onMain(root: string, docs: Record<number, string>) {
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  for (const [n, text] of Object.entries(docs)) writeFileSync(join(root, `canon/changes/C-${n}.md`), text);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "changes");
}
/** C-n delegated by agent:s1 to w1 and started by the worker agent:s7:w1. */
function delegated(root: string) {
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", ["work", "delegate", s.change, "--to", "w1"]).code).toBe(0);
  expect(cli(root, "agent:s7:w1", ["work", "start", s.change]).code).toBe(0);
  return s;
}
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
/** A machine-wide queue of full runs of its own (BR-2576), so no real or other test's run shows up. */
const emptyQueue = () => mkdtempSync(join(tmpdir(), "canon-machine-"));
function queue(gone: (pid: number) => boolean = () => false) {
  const dir = emptyQueue();
  let seq = 0;
  const slots: Slots = { dir, gone: (p) => gone(p.pid) };
  /** A run of `subject` (null: main's floor) by process `pid`: started `startedMin` minutes ago, or waiting. */
  const add = (subject: string | null, pid: number, startedMin?: number) => {
    seq++;
    const entry = { seq, pid, pidStart: `start-${pid}`, subject, worktree: `/w/${pid}`, kind: subject === null ? "floor" : "work-test", queuedAt: Date.now(), ...(startedMin === undefined ? {} : { startedAt: Date.now() - startedMin * 60_000 }) };
    writeFileSync(join(dir, `${String(seq).padStart(12, "0")}-${pid}.json`), JSON.stringify(entry));
  };
  const end = (pid: number) => { for (let n = 1; n <= seq; n++) rmSync(join(dir, `${String(n).padStart(12, "0")}-${pid}.json`), { force: true }); };
  return { slots, add, end };
}
const NONE = (): Slots => queue().slots;
/** A machine-wide load queue of its own (BR-2630): a heavy step of `subject` in `worktree` by process `pid`, queued `minutes` ago. */
function loadQueue(primary: string) {
  const machineDir = emptyQueue();
  const dir = join(machineDir, "load-waits");
  mkdirSync(dir);
  let seq = 0;
  const load: Loads = { dir, gone: () => false };
  const add = (subject: string, pid: number, kind: string, minutes: number, worktree = `${primary}.worktrees/${subject}`) => {
    seq++;
    writeFileSync(join(dir, `${String(seq).padStart(12, "0")}-${pid}.json`), JSON.stringify({ seq, pid, pidStart: `start-${pid}`, subject, worktree, kind, limit: 16, queuedAt: Date.now() - minutes * 60_000 }));
  };
  return { load, add, machineDir };
}

test("BR-2527: ages read 12m, 3h05m and 2d4h", () => {
  expect(age(12 * 60_000)).toBe("12m");
  expect(age(185 * 60_000)).toBe("3h05m");
  expect(age((2 * 24 + 4) * 3_600_000 + 59_000)).toBe("2d4h");
  expect(age(-5)).toBe("0m");
});

test("BR-2527: a main session's findings carry their age and the next command of their tier; tier C and questions are the owner's group; one waiting on the owner shows only as its question", () => {
  const root = fresh();
  const w = ws(root);
  const b = finding(w, 40, "B", "wording");
  const untriaged = finding(w, 5, null, "wording");
  const asked = finding(w, 10, "C");
  const tierC = finding(w, 12, "C", "wording");
  w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, asked_at) VALUES (NULL, 'agent:x', 'close #3 this way?', '[]', 0, ?)").run(minutesAgo(8));
  const q = Number(w.db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM questions").get()!.id);
  w.db.db.query("UPDATE review_findings SET question = ? WHERE id = ?").run(q, asked);
  const before = lastEventId(w.db);
  const a = must(agenda(w, { read: CALM, slots: NONE() }));
  const judge = a.judge.map((it) => renderDue(it));
  expect(judge[0]).toMatch(new RegExp(`^finding:${b} 40m tier B \\[wording\\] BR-1: x contradicts y → needs another session: canon finding advise ${b} `));
  expect(judge[1]).toMatch(new RegExp(`^finding:${untriaged} 5m untriaged .* → canon finding tier ${untriaged} A\\|B\\|C`));
  expect(a.owner.map((it) => it.key)).toEqual([`finding:${tierC}`, `question:${q}`]);
  expect(a.owner[0]!.next).toStartWith(`canon finding ask ${tierC} `);
  expect(renderDue(a.owner[1]!)).toMatch(new RegExp(`^question:${q} 8m close #3 this way\\? → ask the owner`));
  // reason: work waiting on a question can go on with a provisional answer, and a stale one is withdrawn (BR-2636, BR-2628)
  expect(a.owner[1]!.next).toContain(`canon human provisional ${q} "<answer>" --reason`);
  expect(a.owner[1]!.next).toContain(`canon human withdraw ${q} --reason`);
  expect([...a.judge, ...a.owner].some((it) => it.key === `finding:${asked}`)).toBe(false);
  // reason: no claim lapsed, so judging them wrote nothing (BR-2527, BR-2360)
  expect(lastEventId(w.db)).toBe(before);
});

test("BR-2527: what affects main comes first, then what blocks others, then the rest by age; two or more of a kind fold into one line with the oldest age", () => {
  const root = fresh();
  const w = ws(root);
  for (let i = 0; i < 12; i++) finding(w, 3 * 24 * 60 + i, "A", "wording");
  const contradiction = finding(w, 30, null);
  w.db.db.query("INSERT INTO red_main(id, sha, first_sha, log, tail, since, green, change, updated_at) VALUES (1, 'abcdef1234567', 'abcdef1234567', 'floor.log', '', ?, NULL, NULL, ?)").run(minutesAgo(20), minutesAgo(20));
  const lines = agendaLines(must(agenda(w, { read: CALM, slots: NONE() })));
  expect(lines[0]).toBe("judge: 14");
  expect(lines[1]).toMatch(new RegExp(`^  finding:${contradiction} 30m untriaged \\[contradiction\\]`));
  expect(lines[2]).toMatch(/^ {2}red-main 20m the background floor failed on abcdef123 .* → canon work start --fix-main$/);
  expect(lines[3]).toMatch(/^ {2}finding A ×12 oldest 3d0h: finding:12, finding:11, .*, … \+2 → canon finding close <n> --fixed/);
  expect(lines).toHaveLength(4);
});

test("BR-2527: a refused landing is to judge only once no live claim holds the change; a change waiting on a dropped one without done_by is too", () => {
  const root = fresh();
  onMain(root, { 3: changeDoc(3, "dropped"), 4: changeDoc(4, "open", "depends_on: [C-3]\n") });
  const s = startNew(root, "Refused");
  const w = ws(root);
  w.db.event("agent:a", "land.refuse", s.change, { reason: "tests" });
  const keys = () => must(agenda(ws(root), { read: CALM, slots: NONE() })).judge.map((it) => it.key);
  expect(keys()).toEqual(["dropped-dep:C-4"]);
  w.db.db.query("DELETE FROM claims WHERE subject = ?").run(s.change);
  expect(keys()).toEqual([`land-refused:${s.change}`, "dropped-dep:C-4"]);
});

test("BR-2527: canon work due prints nothing due, or an object with empty groups with --json, with exit 0", () => {
  const root = fresh();
  const text = cli(root, "agent:s1", ["work", "due"]);
  expect(text.code).toBe(0);
  expect(text.out.trim()).toBe("nothing due");
  const j = cli(root, "agent:s1", ["work", "due", "--json"]);
  expect(j.code).toBe(0);
  expect(JSON.parse(j.out)).toMatchObject({ judge: [], owner: [], yours: [], heavy: { running: [], waiting: 0, load_waiting: [] } });
  finding(ws(root), 3, "A");
  const one = JSON.parse(cli(root, "agent:s1", ["work", "due", "--json"]).out) as { judge: { key: string; next: string }[] };
  expect(one.judge.map((i) => Object.keys(i).sort())).toEqual([["holds", "key", "kind", "next", "since", "summary"]]);
  expect(one.judge[0]!.next).toStartWith("canon finding close 1 ");
});

test("BR-2527: a worker sees the answer to its design request and its refused landing, never the main session's findings", () => {
  const root = fresh();
  const s = delegated(root);
  finding(ws(root), 3, "A");
  expect(cli(root, "agent:s7:w1", ["work", "need-design", s.change, "which table?"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["work", "design-answer", "1", "the events table"]).code).toBe(0);
  const w = ws(root, "agent:s7:w1");
  w.db.event("agent:s7:w1", "land.refuse", s.change, { reason: "test" });
  const r = must(dueItems(w, Date.now(), CALM, NONE()));
  expect(r.map((i) => i.key)).toEqual([`design-answer:${s.change}`, `land-refused:${s.change}`]);
  expect(r[0]!.next).toBe(`canon work accept-design ${s.change}`);
  expect(agendaLines(must(agenda(w, { read: CALM, slots: NONE() })))[0]).toBe("yours: 2");
  const main = must(dueItems(ws(root, "agent:s1"), Date.now(), CALM, NONE()));
  expect(main.map((i) => i.key)).toEqual(["finding:1"]);
  w.db.event("agent:s7:w1", "land.ok", s.change, {});
  expect(must(dueItems(w, Date.now(), CALM, NONE())).map((i) => i.key)).toEqual([`design-answer:${s.change}`]);
});

test("BR-2527 BR-2241: a change done on main whose landing left a rule without evidence is to judge as unverified: until a done change records the rule's current text; one not landed is not", () => {
  const root = fresh();
  const id = ["BR", 3].join("-");
  const rule = `---\nid: ${id}\ntitle: Refund\nbusiness: x\n---\n## 规则\n\nRefunds go back.\n\n## 例子\n\n- refund → shown\n`;
  const change = (n: number, status: string, passes = "") => `---\nid: C-${n}\ntitle: Work ${n}\nstatus: ${status}\nrules: [${id}]\n${passes}---\n\n## 为什么\n\nx\n`;
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "# billing\n\n## 业务\n\n- **x**：y\n");
  writeFileSync(join(root, `canon/rules/billing/${id}.md`), rule);
  writeFileSync(join(root, "canon/changes/C-7.md"), change(7, "done"));
  writeFileSync(join(root, "canon/changes/C-8.md"), change(8, "open"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "C-7 landed without evidence");
  const w = ws(root);
  w.db.event("agent:a", "execution.unverified", "C-7", { rules: [id] });
  w.db.event("agent:a", "execution.unverified", "C-8", { rules: [id] });
  const keys = must(dueItems(w, Date.now(), CALM, NONE())).map((i) => i.key);
  expect(keys).toContain("unverified:C-7");
  expect(keys).not.toContain("unverified:C-8");
  const item = must(dueItems(w, Date.now(), CALM, NONE())).find((i) => i.key === "unverified:C-7")!;
  expect(item.summary).toContain(`landed with ${id} 待重新执行`);
  expect(item.next).toContain("land --finish");
  const hash = behaviourHash(rule);
  writeFileSync(join(root, "canon/changes/C-9.md"), change(9, "done", `passes:\n  ${id}: "${hash} test"\n`));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "C-9 executed it");
  expect(must(dueItems(ws(root), Date.now(), CALM, NONE())).map((i) => i.key)).not.toContain("unverified:C-7");
});

test("BR-2581 BR-2607: with room, the changes that can start in the owner's order, at most five, both ways, and how many more fit; a running full test run takes a slot", () => {
  const root = fresh();
  onMain(root, { ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, changeDoc(n)])), 8: changeDoc(8).replace("\n## 要改什么\n\nx\n", "\n## 要改什么\n\n") });
  const w = ws(root);
  const q = queue();
  const lines = agendaLines(must(agenda(w, { read: CALM, slots: q.slots })));
  expect(lines.slice(0, 2)).toEqual(["delegate: room for 10 more (load 1.0 of 16 on 8 CPUs, 0/10 slots); start or delegate: your call (D-156)", "  ready:C-1 P2 - Work 1 → canon work start C-1 | canon work delegate C-1 --to <name>"]);
  expect(lines.filter((l) => l.startsWith("  ready:"))).toHaveLength(5);
  expect(lines).toContain("  … 3 more ready (canon change list)");
  expect(lines.some((l) => l.includes("C-8"))).toBe(false);
  q.add("C-637", 4242, 0);
  expect(agendaLines(must(agenda(w, { read: CALM, slots: q.slots })))[0]).toBe("delegate: room for 9 more (load 1.0 of 14.4 on 8 CPUs, 0/10 slots, 1 full test run(s) running); start or delegate: your call (D-156)");
  expect(summary(must(agenda(w, { read: CALM, slots: q.slots })))[1]).toBe("  delegate: room for 9 more (load 1.0 of 14.4 on 8 CPUs, 0/10 slots, 1 full test run(s) running): C-1, C-2, C-3, C-4, C-5");
});

test("BR-2581 BR-2607: busy says why and still lists both ways; a full test run lowers the load limit to 0.9 of it and takes the last slot", () => {
  const root = fresh();
  onMain(root, { 9: changeDoc(9), 10: changeDoc(10) });
  const w = ws(root);
  const q = queue();
  expect(agendaLines(must(agenda(w, { read: machine(15), slots: q.slots })))[0]).toStartWith("delegate: room for 10 more");
  expect(agendaLines(must(agenda(w, { read: machine(16), slots: q.slots })))[0]).toBe("delegate: busy (5-minute load 16.0 on 8 CPUs (limit 16)); 0/10 slots; light delegations still fit 10: canon work delegate <C-n> --to <name> --light \"<why>\"; start or delegate: your call (D-156)");
  q.add(null, 4242, 0);
  const busy = agendaLines(must(agenda(w, { read: machine(15), slots: q.slots })));
  expect(busy).toEqual(["delegate: busy (5-minute load 15.0 on 8 CPUs (limit 14.4 while a full test run is running)); 0/10 slots; light delegations still fit 9: canon work delegate <C-n> --to <name> --light \"<why>\"; start or delegate: your call (D-156)", "  ready:C-9 P2 - Work 9 → canon work start C-9 | canon work delegate C-9 --to <name>", "  ready:C-10 P2 - Work 10 → canon work start C-10 | canon work delegate C-10 --to <name>", "heavy: main full test run 0m"]);
  expect(summary(must(agenda(w, { read: machine(15), slots: q.slots })))[1]).toBe("  delegate: busy (5-minute load 15.0 on 8 CPUs (limit 14.4 while a full test run is running)); 0/10 slots; light delegations still fit 9: canon work delegate <C-n> --to <name> --light \"<why>\"; delegatable once it falls: C-9, C-10");
  const slots = roomOf({ ...w, config: { ...w.config, delegateMaxWorkers: 10 } } as Workspace, CALM(), 9, 1);
  expect([slots.room, slots.reasons]).toEqual([false, ["9 of delegate_max_workers (10) in use; 1 full test run(s) take the last slot(s)"]]);
  expect(roomOf(w, machine(1, true)(), 0, 0).reasons).toEqual(["memory pressure warn"]);
});

test("BR-2582: the full test runs running and waiting come from the machine-wide queue; a run whose process is gone is neither", () => {
  const root = fresh();
  const w = ws(root);
  const q = queue((pid) => pid === 3);
  q.add("C-637", 1, 12);
  q.add(null, 7, 2);
  q.add("C-5", 2);
  q.add("C-6", 4);
  q.add("C-7", 3, 1);
  const h = must(runningFullRuns(q.slots));
  expect(h.running.map((r) => r.subject)).toEqual(["C-637", "main"]);
  expect(h.waiting).toBe(2);
  expect(agendaLines(must(agenda(w, { read: CALM, slots: q.slots })))).toEqual(["heavy: C-637 full test run 12m, main full test run 2m; 2 waiting"]);
  q.end(1); q.end(7);
  expect(agendaLines(must(agenda(w, { read: CALM, slots: q.slots })))).toEqual(["heavy: none running; 2 waiting"]);
  expect(must(runningFullRuns(NONE()))).toEqual({ running: [], waiting: 0, loadWaiting: [], lane: { running: [], waiting: 0 } });
  expect(must(runningFullRuns({ dir: join(emptyQueue(), "missing"), gone: () => false }))).toEqual({ running: [], waiting: 0, loadWaiting: [], lane: { running: [], waiting: 0 } });
});

test("BR-2583: canon work handled records each key's outcome as a reminder.handled event and the agenda leaves them out while it holds", () => {
  const root = fresh();
  onMain(root, { 20: changeDoc(20) });
  const w = ws(root);
  const a = finding(w, 30, "A", "wording");
  const b = finding(w, 20, "A", "wording");
  const c = finding(w, 10, "A", "wording");
  const handed = cli(root, "agent:s1", ["work", "handled", `finding:${a},finding:${b}`, "--to", "C-20"]);
  expect(handed.code).toBe(0);
  expect(handed.out.trim().split("\n")).toEqual([`handled finding:${a}: handed to C-20`, `handled finding:${b}: handed to C-20`]);
  const ev = w.db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'reminder.handled' ORDER BY id").all();
  expect(ev.map((e) => [e.subject, JSON.parse(e.detail).outcome, JSON.parse(e.detail).to, JSON.parse(e.detail).via])).toEqual([[`finding:${a}`, "handed", "C-20", "handled"], [`finding:${b}`, "handed", "C-20", "handled"]]);
  expect(cli(root, "agent:s1", ["work", "handled", `finding:${c}`, "--defer", "after the release", "--for", "4h"]).out).toMatch(new RegExp(`^handled finding:${c}: deferred until \\S+: after the release`));
  expect(must(agenda(ws(root), { read: CALM, slots: NONE() })).judge.map((it) => it.key)).toEqual([]);
  // a deferral ends; a hand-over ends when the change it went to closes and the item is still there
  expect(must(agenda(ws(root), { read: CALM, now: Date.now() + 5 * 3_600_000, slots: NONE() })).judge.map((it) => it.key)).toEqual([`finding:${c}`]);
  onMain(root, { 20: changeDoc(20, "done") });
  expect(must(agenda(ws(root), { read: CALM, slots: NONE() })).judge.map((it) => it.key)).toEqual([`finding:${a}`, `finding:${b}`]);
  expect(cli(root, "agent:s1", ["work", "handled", `finding:${a}`, "--not-doing", "covered by the guide"]).code).toBe(0);
  expect(must(agenda(ws(root), { read: CALM, slots: NONE() })).judge.map((it) => it.key)).toEqual([`finding:${b}`]);
  expect(cli(root, "agent:s1", ["work", "handled", "ready:C-21", "--not-doing", "x"]).code).toBe(3);
});

test("BR-2583: an item that began again after its outcome shows again; a key not on the agenda or a closed change is refused with exit 3; a bad outcome is a usage error", () => {
  const o = { key: "stalled:C-5", outcome: "not-doing" as const, to: null, reason: "x", until: null, since: "2026-11-20T01:00:00.000Z", via: "handled" as const, at: "2026-11-20T02:00:00.000Z" };
  expect(holds(o, "2026-11-20T01:00:00.000Z", () => false, Date.now())).toBe(true);
  expect(holds(o, "2026-11-20T03:00:00.000Z", () => false, Date.now())).toBe(false);
  const root = fresh();
  onMain(root, { 30: changeDoc(30, "done") });
  const f = finding(ws(root), 5, "A");
  const before = lastEventId(ws(root).db);
  const missing = cli(root, "agent:s1", ["work", "handled", "finding:99", "--to", "C-30"]);
  expect([missing.code, missing.err.includes("finding:99")]).toEqual([3, true]);
  expect(cli(root, "agent:s1", ["work", "handled", `finding:${f}`, "--to", "C-30"]).code).toBe(3);
  const kinds = ws(root).db.db.query<{ kind: string }, [number]>("SELECT kind FROM events WHERE id > ?").all(before).map((r) => r.kind);
  expect(kinds).toEqual(["reminder.handled.refuse", "reminder.handled.refuse"]);
  for (const args of [[], ["--to", "C-30", "--not-doing", "x"], ["--defer", "x"], ["--defer", "x", "--for", "4w"], ["--not-doing", " "], ["--to", "C-30", "--for", "4h"]]) {
    expect(cli(root, "agent:s1", ["work", "handled", `finding:${f}`, ...args]).code).toBe(2);
  }
  expect(cli(root, "agent:s7:w1", ["work", "handled", `finding:${f}`, "--not-doing", "x"]).code).toBe(2);
});

test("BR-2584: a main session's landing ends with the agenda summary and the findings on what it touched; nothing for an empty agenda", () => {
  const root = fresh();
  const quiet = startNew(root, "Quiet");
  sh(quiet.worktree, "commit", "-qam", "x", "--allow-empty");
  const calm = cli(quiet.worktree, "agent:a", ["work", "land", "--finish", "--timeout", "5"]);
  expect(calm.code).toBe(0);
  expect(calm.out).not.toContain("Agenda (canon work due):");
  const s = startNew(root, "Touches");
  const w = ws(root);
  const mine = finding(w, 15, "A", "wording", [s.change]);
  const other = finding(w, 5, "A", "wording", ["BR-77"]);
  writeFileSync(join(s.worktree, "app.txt"), "changed\n");
  sh(s.worktree, "commit", "-qam", "work");
  const r = cli(s.worktree, "agent:a", ["work", "land", "--finish", "--timeout", "5"]);
  expect(r.code).toBe(0);
  const lines = r.out.split("\n");
  const at = lines.indexOf("Agenda (canon work due):");
  expect(at).toBeGreaterThan(-1);
  expect(lines[at + 1]).toBe(`  judge: 2: finding A ×2`);
  expect(lines[at + 2]).toBe(`Findings on what ${s.change} touched:`);
  expect(lines[at + 3]).toMatch(new RegExp(`^  finding:${mine} 15m tier A `));
  expect(r.out).not.toContain(`  finding:${other} `);
});

test("BR-2585: canon stats reports how reminders were handled: the rate, each outcome, the time to outcome and hand-overs still open after landing", () => {
  const root = fresh();
  onMain(root, { 40: changeDoc(40), 41: changeDoc(41) });
  const w = ws(root);
  const a = finding(w, 120, "A");
  const b = finding(w, 10, "A");
  const c = finding(w, 5, "A");
  finding(w, 1, "A");
  expect(cli(root, "agent:s1", ["work", "handled", `finding:${a},finding:${b}`, "--to", "C-40"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["work", "handled", `finding:${c}`, "--not-doing", "dup"]).code).toBe(0);
  onMain(root, { 40: changeDoc(40, "done") });
  const out = cli(root, "agent:s1", ["stats"]).out;
  const at = out.indexOf("Reminders\n");
  expect(at).toBeGreaterThan(-1);
  expect(out.slice(at).split("\n").slice(0, 7)).toEqual([
    "Reminders",
    "  handled 3 of 4 (75%)",
    "  handed 2 (2 landed, 0 open, 0 dropped)",
    "  deferred 0",
    "  not-doing 1",
    expect.stringMatching(/^ {2}time to outcome: median 10m, max 2h0[01]m$/),
    `  handed but still open after landing: finding:${a}, finding:${b}`,
  ]);
  expect(cli(fresh(), "agent:s1", ["stats"]).out).not.toContain("Reminders");
});

/** A scripted run of watchDue: `at[n]` runs before tick n; it stops after `ticks` ticks; each tick moves the clock by `stepMs`. */
async function scripted(w: Workspace, opts: { since?: number; ticks: number; stepMs?: number; at?: Record<number, () => void>; read?: Readings; slots?: Slots }) {
  const out: string[] = [];
  let clock = Date.now();
  let tick = 0;
  const r = await watchDue(w, opts.since, {
    out: (l) => out.push(l),
    stopped: () => tick >= opts.ticks,
    sleep: async (ms) => { clock += opts.stepMs ?? ms; tick++; opts.at?.[tick]?.(); },
    clock: () => clock,
  }, { read: opts.read ?? CALM, slots: opts.slots ?? NONE() });
  return { r, out };
}

test("BR-2528: watch starts with watch from and the agenda summary, then prints the events that concern the session and what changes, never repeating what stays open", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const f = finding(w, 40, "B");
  const start = lastEventId(w.db);
  const { r, out } = await scripted(w, {
    ticks: 200,
    stepMs: RECOMPUTE_MS,
    at: {
      1: () => { w.db.event("agent:other", "land.ok", "C-7", {}); w.db.event("agent:other", "search", null, {}); },
      190: () => { w.db.db.query("UPDATE review_findings SET closed_at = ? WHERE id = ?").run(new Date().toISOString(), f); },
    },
  });
  expect(r.ok).toBe(true);
  expect(out.slice(0, 3)).toEqual([`watch from #${start}`, "Agenda (canon work due):", `  judge: 1: finding:${f}`]);
  expect(out).toContainEqual(expect.stringMatching(/^#\d+ land\.ok C-7 agent:other → canon work after-land --wait C-7$/));
  expect(out.some((l) => l.includes(" search "))).toBe(false);
  expect(out.at(-1)).toBe(`- finding:${f}`);
  // three hours and more of an open item: nothing said about it between the summary and its end (BR-2528, D-151)
  expect(out.filter((l) => l.includes(`finding:${f}`))).toHaveLength(2);
  expect(out.some((l) => l.startsWith("still "))).toBe(false);
});

test("BR-2528: an empty agenda prints only watch from; a new item is said with +, at most ten at once", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const { out } = await scripted(w, { ticks: 2, at: { 1: () => { for (let i = 0; i < 12; i++) finding(w, 1, "A"); w.db.event("agent:x", "review.block", null, {}); } } });
  expect(out[0]).toMatch(/^watch from #\d+$/);
  expect(out.filter((l) => l.startsWith("+ judge finding:"))).toHaveLength(10);
  expect(out).toContain("… +2 more: canon work due");
});

test("BR-2528: after a landing, whoever landed, the changes that can start because of it follow its land.ok line", async () => {
  const root = fresh();
  onMain(root, { 1: changeDoc(1), 2: changeDoc(2, "open", "depends_on: [C-1]\n") });
  const w = ws(root, "agent:s1");
  const { out } = await scripted(w, {
    ticks: 2,
    at: { 1: () => { onMain(root, { 1: changeDoc(1, "done") }); w.db.event("agent:s7:w1", "land.ok", "C-1", {}); } },
  });
  const at = out.findIndex((l) => /^#\d+ land\.ok C-1 agent:s7:w1/.test(l));
  expect(at).toBeGreaterThan(-1);
  expect(out[at + 1]).toBe("C-1 landed; C-2 can start now");
  expect(out).toContain("+ delegate ready:C-2 P2 - Work 2 → canon work start C-2 | canon work delegate C-2 --to <name>");
  expect(out).toContain("- ready:C-1");
});

test("BR-2528: the machine is read every second and said once when it crosses the threshold, with hysteresis", async () => {
  const root = fresh();
  onMain(root, { 9: changeDoc(9) });
  const w = ws(root, "agent:s1");
  const loads = [15.9, 16.1, 15.0, 16.3, 15.0, 14.3, 14.0];
  let i = 0;
  const { out } = await scripted(w, { ticks: loads.length - 1, at: Object.fromEntries(loads.map((_, n) => [n, () => { i = n; }])), read: () => machine(loads[i]!)() });
  const capacity = out.filter((l) => l.startsWith("capacity "));
  expect(capacity).toEqual(["capacity busy: 5-minute load 16.1 on 8 CPUs (limit 16); delegate no new worker", "capacity room: room for 10 more; delegatable: C-9"]);
});

test("BR-2528: a full test run starting or ending is said in one heavy line; its growing age is not", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const q = queue();
  const { out } = await scripted(w, {
    ticks: 4,
    stepMs: 30_000,
    slots: q.slots,
    at: { 1: () => { q.add("C-637", 77, 0); w.db.event("agent:t", "test.full.start", "C-637", {}); }, 3: () => { q.end(77); w.db.event("agent:t", "test.full.end", "C-637", {}); } },
  });
  expect(out.filter((l) => l.startsWith("heavy:"))).toEqual(["heavy: C-637 full test run 0m", "heavy: none"]);
});

test("BR-2528: more than 20 events in one round print 20 and a line to read the rest; --since replays missed ones first", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const from = lastEventId(w.db);
  w.db.event("agent:other", "land.ok", "C-1", {});
  w.db.event("agent:other", "search", null, {});
  w.db.event("agent:other", "land.refuse", "C-2", { reason: "tests" });
  const replay = await scripted(w, { since: from, ticks: 0 });
  expect(replay.out.slice(0, 3)).toEqual([`watch from #${from}`, expect.stringMatching(/^#\d+ land\.ok C-1 /), expect.stringMatching(/^#\d+ land\.refuse C-2 agent:other tests → canon events --subject C-2 --kind land\.refuse$/)]);
  const burst = await scripted(w, {
    ticks: 2,
    at: { 1: () => { for (let i = 0; i < 25; i++) w.db.event("agent:other", "land.ok", `C-${100 + i}`, {}); } },
  });
  const lines = burst.out.filter((l) => l.startsWith("#"));
  expect(lines).toHaveLength(20);
  const lastShown = Number(/^#(\d+)/.exec(lines.at(-1)!)![1]);
  expect(burst.out).toContain(`… 5 more events: canon events --since ${lastShown}`);
});

test("BR-2528: a worker hears only about its own changes and gets no capacity lines", async () => {
  const root = fresh();
  const s = delegated(root);
  const w = ws(root, "agent:s7:w1");
  const { out } = await scripted(w, {
    ticks: 2,
    read: machine(99),
    at: { 1: () => { w.db.event("agent:other", "land.ok", "C-77", {}); w.db.event("agent:s1", "design.answer", s.change, { request: 1 }); } },
  });
  expect(out.some((l) => l.includes("C-77"))).toBe(false);
  expect(out.some((l) => l.startsWith("capacity "))).toBe(false);
  expect(out).toContainEqual(expect.stringMatching(new RegExp(`^#\\d+ design\\.answer ${s.change} agent:s1 → canon work accept-design ${s.change}$`)));
});

test("BR-2528: a deleted coordination database stops watch with a watch stopped line and exit 4; SIGTERM ends it with exit 0; remind_every_minutes is gone", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const file = w.db.db.filename;
  const { r, out } = await scripted(w, { ticks: 3, at: { 1: () => rmSync(file) } });
  expect(r.ok ? "" : r.error.code).toBe("io");
  expect(out.at(-1)).toMatch(/^watch stopped: the coordination database .* is gone; run canon work watch --since \d+ again$/);
  const root2 = fresh();
  const p = Bun.spawn(["bun", MAIN, "work", "watch"], { cwd: root2, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1", CANON_MACHINE: "normal,1,8" } });
  const reader = p.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toStartWith("watch from #");
  p.kill("SIGTERM");
  expect(await p.exited).toBe(0);
  writeFileSync(join(root2, "canon/config.yaml"), `${readFileSync(join(root2, "canon/config.yaml"), "utf8")}remind_every_minutes: 30\n`);
  const removed = cli(root2, "agent:s1", ["work", "watch"]);
  expect(removed.code).toBe(2);
  expect(removed.err).toContain("`remind_every_minutes` was removed");
});

test("BR-2529 BR-2024: a Claude Code main session's brief has the agenda summary and the Monitor line; Codex gets no Monitor line; a worker and a claimed worktree get neither", () => {
  const root = fresh();
  const hint = "Keep canon work watch running under Monitor (timeout 30 min); when it expires, re-arm with --since <the last event number it printed>.";
  const empty = cli(root, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(empty.out).not.toContain("Agenda (canon work due):");
  expect(empty.out).toContain(hint);
  finding(ws(root), 120, "A");
  onMain(root, { 9: changeDoc(9) });
  const claude = cli(root, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(claude.out).toContain("Agenda (canon work due):\n  delegate: room for 10 more (load 1.0 of 16 on 8 CPUs, 0/10 slots): C-9\n  judge: 1: finding:1\n");
  expect(claude.out).toContain(hint);
  const codex = cli(root, "agent:s1", ["brief"]);
  expect(codex.out).toContain("  judge: 1: finding:1");
  expect(codex.out).not.toContain("Monitor");
  const s = startNew(root, "Mine", "agent:s1");
  const claimed = cli(s.worktree, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(claimed.out).not.toContain("Agenda (canon work due)");
  expect(claimed.out).not.toContain("Monitor");
  const worker = cli(root, "agent:s7:w1", ["brief"], { CLAUDECODE: "1" });
  expect(worker.out).not.toContain("Agenda (canon work due)");
  expect(worker.out).not.toContain("Monitor");
});

test("BR-2582 BR-2630: steps waiting for the load are listed in the heavy line with their kind and wait; a full run that holds a slot but waits for the load is not running; other repositories' steps carry their worktree", () => {
  const root = fresh();
  const w = ws(root);
  const q = queue();
  const l = loadQueue(w.primary);
  l.add("C-9", 1, "test", 4);
  l.add("C-10", 2, "land", 1);
  const read = (slots: Slots) => must(agenda(w, { read: CALM, slots, load: l.load }));
  expect(agendaLines(read(q.slots))).toEqual(["heavy: none running; 2 waiting for the load (C-9 test 4m, C-10 land 1m)"]);
  // C-9 holds the only slot and waits for the load: it is only in the load group, never "full test run"
  q.add("C-9", 1, 4);
  expect(agendaLines(read(q.slots))).toEqual(["heavy: none running; 2 waiting for the load (C-9 test 4m, C-10 land 1m)"]);
  expect(must(runningFullRuns(q.slots, l.load)).running).toEqual([]);
  // another full run that passed the load gate runs; another repository's step is named with its worktree
  q.add("C-5", 3, 7);
  l.add("C-1", 4, "heavy-run", 0, "/elsewhere/C-1");
  const line = agendaLines(read(q.slots))[0]!;
  expect(line).toStartWith("heavy: C-5 full test run 7m; 3 waiting for the load (C-9 test 4m, C-10 land 1m, C-1（/elsewhere/C-1） heavy-run 0m)");
  const json = agendaJson(read(q.slots)) as { heavy: { load_waiting: { subject: string; kind: string }[] } };
  expect(json.heavy.load_waiting.map((x) => [x.subject, x.kind])).toEqual([["C-9", "test"], ["C-10", "land"], ["C-1（/elsewhere/C-1）", "heavy-run"]]);
});

test("BR-2582: with six steps waiting for the load the line names five and counts the rest; nothing waiting and nothing running prints no heavy line", () => {
  const root = fresh();
  const w = ws(root);
  const l = loadQueue(w.primary);
  const line = (slots: Slots) => agendaLines(must(agenda(w, { read: CALM, slots, load: l.load })));
  expect(line(NONE())).toEqual([]);
  for (let i = 1; i <= 6; i++) l.add(`C-${i}`, i, "test", i);
  expect(line(NONE())[0]).toBe("heavy: none running; 6 waiting for the load (C-1 test 1m, C-2 test 2m, C-3 test 3m, C-4 test 4m, C-5 test 5m, … +1)");
});
