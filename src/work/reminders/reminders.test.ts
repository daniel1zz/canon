import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import type { Workspace } from "../workspace.ts";
import { age, dueItems, renderDue } from "./due.ts";
import { watchDue, RECOMPUTE_MS } from "./watch.ts";
import { lastEventId } from "../stats/window.ts";

// reason: each case spawns canon or git several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, args: readonly string[], extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, ...extra } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const CALM = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
function fresh(): string {
  const root = project(); roots.push(root);
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  return root;
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function finding(w: Workspace, minutes: number, tier: string | null = null, text = "x contradicts y"): number {
  return Number(w.db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at, tier) VALUES (?, 'contradiction', '[\"BR-1\"]', '[\"BR-1\"]', ?, 'C-9', 1, 'abc', ?, ?)").run(`id-${Math.random()}`, text, minutesAgo(minutes), tier).lastInsertRowid);
}
/** C-n delegated by agent:s1 to w1 and started by the worker agent:s7:w1. */
function delegated(root: string) {
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", ["work", "delegate", s.change, "--to", "w1"]).code).toBe(0);
  expect(cli(root, "agent:s7:w1", ["work", "start", s.change]).code).toBe(0);
  return s;
}

test("BR-2527: ages read 12m, 3h05m and 2d4h", () => {
  expect(age(12 * 60_000)).toBe("12m");
  expect(age(185 * 60_000)).toBe("3h05m");
  expect(age((2 * 24 + 4) * 3_600_000 + 59_000)).toBe("2d4h");
  expect(age(-5)).toBe("0m");
});

test("BR-2527: a main session's findings carry their age and the next command of their tier; one waiting on the owner shows only as its question", () => {
  const root = fresh();
  const w = ws(root);
  const b = finding(w, 40, "B");
  const untriaged = finding(w, 5);
  const owners = finding(w, 10, "C");
  w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, asked_at) VALUES (NULL, 'agent:x', 'close #3 this way?', '[]', 0, ?)").run(minutesAgo(8));
  const q = Number(w.db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM questions").get()!.id);
  w.db.db.query("UPDATE review_findings SET question = ? WHERE id = ?").run(q, owners);
  const before = lastEventId(w.db);
  const r = dueItems(w, Date.now(), CALM);
  if (!r.ok) throw new Error(r.error.message);
  const lines = r.value.map((it) => renderDue(it));
  expect(lines[0]).toMatch(new RegExp(`^finding:${b} 40m tier B \\[contradiction\\] BR-1: x contradicts y → needs another session: canon finding advise ${b} `));
  expect(lines[1]).toMatch(new RegExp(`^finding:${untriaged} 5m untriaged .* → canon finding tier ${untriaged} A\\|B\\|C`));
  expect(lines.filter((l) => l.startsWith(`finding:${owners} `))).toEqual([]);
  expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^question:${q} 8m close #3 this way\\? → ask the owner`)));
  // reason: no claim lapsed, so judging them wrote nothing (BR-2527, BR-2360)
  expect(lastEventId(w.db)).toBe(before);
});

test("BR-2527: a red main and a machine under pressure are due for a main session; capacity starts now", () => {
  const root = fresh();
  const w = ws(root);
  w.db.db.query("INSERT INTO red_main(id, sha, first_sha, log, tail, since, green, change, updated_at) VALUES (1, 'abcdef1234567', 'abcdef1234567', 'floor.log', '', ?, NULL, NULL, ?)").run(minutesAgo(20), minutesAgo(20));
  const r = dueItems(w, Date.now(), () => ({ memory: { tight: true, text: "memory pressure warn" }, machine: { load5: 1, cpus: 8 } }));
  if (!r.ok) throw new Error(r.error.message);
  const lines = r.value.map((it) => renderDue(it));
  expect(lines).toContainEqual(expect.stringMatching(/^red-main 20m the background floor failed on abcdef123 .* → canon work start --fix-main$/));
  expect(lines).toContainEqual("capacity 0m memory pressure warn → wait for workers to land; delegate no new one");
  expect(r.value.find((it) => it.key === "capacity")!.since).toBe("now");
});

test("BR-2527: canon work due prints nothing due, or [] with --json, with exit 0", () => {
  const root = fresh();
  const text = cli(root, "agent:s1", ["work", "due"]);
  expect(text.code).toBe(0);
  expect(text.out.trim()).toBe("nothing due");
  const j = cli(root, "agent:s1", ["work", "due", "--json"]);
  expect(j.code).toBe(0);
  expect(JSON.parse(j.out)).toEqual([]);
  finding(ws(root), 3, "A");
  const one = JSON.parse(cli(root, "agent:s1", ["work", "due", "--json"]).out) as { key: string; since: string; summary: string; next: string }[];
  expect(one.map((i) => Object.keys(i).sort())).toEqual([["key", "next", "since", "summary"]]);
  expect(one[0]!.next).toStartWith("canon finding close 1 ");
});

test("BR-2527: a worker sees the answer to its design request and its refused landing, never the main session's findings", () => {
  const root = fresh();
  const s = delegated(root);
  finding(ws(root), 3, "A");
  expect(cli(root, "agent:s7:w1", ["work", "need-design", s.change, "which table?"]).code).toBe(0);
  expect(cli(root, "agent:s1", ["work", "design-answer", "1", "the events table"]).code).toBe(0);
  const w = ws(root, "agent:s7:w1");
  w.db.event("agent:s7:w1", "land.refuse", s.change, { reason: "test" });
  const r = dueItems(w, Date.now(), CALM);
  if (!r.ok) throw new Error(r.error.message);
  expect(r.value.map((i) => i.key)).toEqual([`design-answer:${s.change}`, `land-refused:${s.change}`]);
  expect(r.value[0]!.next).toBe(`canon work accept-design ${s.change}`);
  // the main session sees the finding and the answered request no longer
  const main = dueItems(ws(root, "agent:s1"), Date.now(), CALM);
  expect(main.ok ? main.value.map((i) => i.key) : []).toEqual(["finding:1"]);
  // landing since clears the refusal
  w.db.event("agent:s7:w1", "land.ok", s.change, {});
  const after = dueItems(w, Date.now(), CALM);
  expect(after.ok ? after.value.map((i) => i.key) : []).toEqual([`design-answer:${s.change}`]);
});

/** A scripted run of watchDue: `at[n]` runs before tick n; it stops after `ticks` ticks; each tick moves the clock by `stepMs`. */
async function scripted(w: Workspace, opts: { since?: number; ticks: number; stepMs?: number; at?: Record<number, () => void>; remindMs?: number; read?: typeof CALM }) {
  const out: string[] = [];
  let clock = Date.now();
  let tick = 0;
  const r = await watchDue(w, opts.since, {
    out: (l) => out.push(l),
    stopped: () => tick >= opts.ticks,
    sleep: async (ms) => { clock += opts.stepMs ?? ms; tick++; opts.at?.[tick]?.(); },
    clock: () => clock,
  }, opts.read ?? CALM, opts.remindMs);
  return { r, out };
}

test("BR-2528: watch starts with watch from and the due list, then prints events that concern the session, items that go, and still lines", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const f = finding(w, 40, "B");
  const start = lastEventId(w.db);
  const { r, out } = await scripted(w, {
    ticks: 4,
    stepMs: RECOMPUTE_MS,
    remindMs: 2 * RECOMPUTE_MS,
    at: {
      1: () => { w.db.event("agent:other", "land.ok", "C-7", {}); w.db.event("agent:other", "search", null, {}); },
      3: () => { w.db.db.query("UPDATE review_findings SET closed_at = ? WHERE id = ?").run(new Date().toISOString(), f); },
    },
  });
  expect(r.ok).toBe(true);
  expect(out[0]).toBe(`watch from #${start}`);
  expect(out[1]).toMatch(new RegExp(`^due finding:${f} 40m tier B .* canon finding advise ${f} `));
  expect(out).toContainEqual(expect.stringMatching(/^#\d+ land\.ok C-7 agent:other → canon work after-land --wait C-7$/));
  expect(out.some((l) => l.includes(" search "))).toBe(false);
  expect(out).toContainEqual(expect.stringMatching(new RegExp(`^still finding:${f} 4[12]m$`)));
  expect(out.at(-1)).toBe(`done finding:${f}`);
});

test("BR-2528: still lines list at most 10 keys and point at canon work due for the rest", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  for (let i = 0; i < 12; i++) finding(w, 5);
  const { out } = await scripted(w, { ticks: 2, stepMs: 60_000, remindMs: 60_000 });
  const still = out.find((l) => l.startsWith("still "))!;
  expect(still.split(", ")).toHaveLength(10);
  expect(still).toEndWith(" … and 2 more: canon work due");
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

test("BR-2528: a worker hears only about its own changes", async () => {
  const root = fresh();
  const s = delegated(root);
  const w = ws(root, "agent:s7:w1");
  const { out } = await scripted(w, {
    ticks: 2,
    at: { 1: () => { w.db.event("agent:other", "land.ok", "C-77", {}); w.db.event("agent:s1", "design.answer", s.change, { request: 1 }); } },
  });
  expect(out.some((l) => l.includes("C-77"))).toBe(false);
  expect(out).toContainEqual(expect.stringMatching(new RegExp(`^#\\d+ design\\.answer ${s.change} agent:s1 → canon work accept-design ${s.change}$`)));
});

test("BR-2528: a deleted coordination database stops watch with a watch stopped line and exit 4; SIGTERM ends it with exit 0", async () => {
  const root = fresh();
  const w = ws(root, "agent:s1");
  const file = w.db.db.filename;
  const { r, out } = await scripted(w, { ticks: 3, at: { 1: () => rmSync(file) } });
  expect(r.ok ? "" : r.error.code).toBe("io");
  expect(out.at(-1)).toMatch(/^watch stopped: the coordination database .* is gone; run canon work watch --since \d+ again$/);
  const root2 = fresh();
  const p = Bun.spawn(["bun", MAIN, "work", "watch"], { cwd: root2, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1" } });
  const reader = p.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toStartWith("watch from #");
  p.kill("SIGTERM");
  expect(await p.exited).toBe(0);
});

test("BR-2529: a Claude Code main session's brief lists what is due and the Monitor line; Codex gets no Monitor line; a worker and a claimed worktree get neither", () => {
  const root = fresh();
  const hint = "Keep canon work watch running under Monitor (timeout 30 min); when it expires, re-arm with --since <the last event number it printed>.";
  const empty = cli(root, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(empty.out).not.toContain("Due now (canon work due):");
  expect(empty.out).toContain(hint);
  finding(ws(root), 120, "A");
  const claude = cli(root, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(claude.out).toContain("Due now (canon work due):\n  finding:1 2h00m tier A ");
  expect(claude.out).toContain(hint);
  const codex = cli(root, "agent:s1", ["brief"]);
  expect(codex.out).toContain("finding:1 2h00m");
  expect(codex.out).not.toContain("Monitor");
  const s = startNew(root, "Mine", "agent:s1");
  const claimed = cli(s.worktree, "agent:s1", ["brief"], { CLAUDECODE: "1" });
  expect(claimed.out).not.toContain("Due now");
  expect(claimed.out).not.toContain("Monitor");
  const worker = cli(root, "agent:s7:w1", ["brief"], { CLAUDECODE: "1" });
  expect(worker.out).not.toContain("Due now");
  expect(worker.out).not.toContain("Monitor");
});
