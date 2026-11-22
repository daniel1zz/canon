import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../session/load.ts";
import { loadWaitsNow, passLoadGate, type LoadDeps, type LoadRequest } from "./load-gate.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "canon-load-"));

/** A machine the tests drive: a clock that only moves when somebody sleeps, a load they set, and the pids the process table says are gone. */
function world(dir: string) {
  const w = { now: 1_000_000, load: 17 as number | undefined, dead: new Set<number>() };
  const deps = (pid: number): LoadDeps => ({
    dir, pollMs: 100, intervalMs: 60_000, quietMs: 300_000,
    now: () => w.now,
    self: () => ({ pid, start: `start-${pid}` }),
    gone: (p) => w.dead.has(p.pid),
    // reason: every sleep moves the shared clock, so the 60-second spacing is crossed without waiting for it
    sleep: async (ms) => { w.now += ms; await Bun.sleep(1); },
    read: (): Machine | undefined => (w.load === undefined ? undefined : { load5: w.load, cpus: 8 }),
  });
  return { w, deps };
}

function request(subject: string, over: Partial<LoadRequest> = {}) {
  const lines: string[] = [];
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  const req: LoadRequest = { kind: "test", subject, worktree: `/wt/${subject}`, perCpu: 2, say: (l) => lines.push(l), aborted: () => false, record: (kind, detail) => events.push({ kind, detail }), ...over };
  return { req, lines, events };
}

const settle = () => Bun.sleep(60);
const names = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".json"));

describe("heavy steps wait for the machine load", () => {
  test("BR-2630: with nobody waiting, a load under the limit and no earlier release, a step goes at once: no line, no event, no queue file", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    w.load = 12;
    const a = request("C-9");
    expect(await passLoadGate(deps(101), a.req)).toEqual({ ok: true, value: "go" });
    expect(a.lines).toEqual([]);
    expect(a.events).toEqual([]);
    expect(names(dir)).toEqual([]);
    expect(existsSync(join(dir, "released"))).toBe(false);
    // two steps arriving together under the limit both go: only the queue is serialised, not a step that does not wait
    w.load = 15;
    expect((await Promise.all([passLoadGate(deps(102), request("C-10").req), passLoadGate(deps(103), request("C-11").req)])).map((r) => r.ok && r.value)).toEqual(["go", "go"]);
  });

  test("BR-2630: a load of 15.96 on 8 CPUs is under a limit of 16; 16.0 is not", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    w.load = 15.96;
    expect(await passLoadGate(deps(101), request("C-9").req)).toEqual({ ok: true, value: "go" });
    w.load = 16;
    const b = request("C-10");
    const pending = passLoadGate(deps(102), b.req);
    await settle();
    expect(b.lines).toHaveLength(1);
    w.load = 14;
    expect(await pending).toEqual({ ok: true, value: "go" });
  });

  test("BR-2630: over the limit a step queues, says the load, the limit and how many are ahead, records load.wait, and goes with load.start when the load falls", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const a = request("C-9");
    const pending = passLoadGate(deps(101), a.req);
    await settle();
    expect(a.lines).toEqual(["canon: waiting for the machine load: 5-minute load 17.0 on 8 CPUs (limit 16); 0 step(s) ahead on this machine; the wait does not count toward test_timeout_minutes"]);
    expect(a.events).toHaveLength(1);
    expect(a.events[0]).toMatchObject({ kind: "load.wait", detail: { kind: "test", ahead: 0, load: 17, cpus: 8, limit: 16 } });
    expect(loadWaitsNow(deps(0))).toMatchObject({ ok: true, value: [{ subject: "C-9", worktree: "/wt/C-9", kind: "test", limit: 16 }] });
    w.load = 15.9;
    expect(await pending).toEqual({ ok: true, value: "go" });
    expect(a.events.map((e) => e.kind)).toEqual(["load.wait", "load.start"]);
    expect(a.events[1]!.detail["waited_ms"]).toBeGreaterThan(0);
    expect(names(dir)).toEqual([]);
  });

  test("BR-2630: steps go one at a time in arrival order, at least 60 seconds apart, even when the load is low from the first", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const left: { who: string; at: number }[] = [];
    const run = (pid: number, subject: string) => {
      const r = request(subject);
      return passLoadGate(deps(pid), r.req).then(() => { left.push({ who: subject, at: w.now }); return r; });
    };
    const first = run(101, "C-9");
    await settle();
    const second = run(102, "C-10");
    await settle();
    const third = run(103, "C-11");
    await settle();
    w.load = 14;
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(left.map((l) => l.who)).toEqual(["C-9", "C-10", "C-11"]);
    expect(left[1]!.at - left[0]!.at).toBeGreaterThanOrEqual(60_000);
    expect(left[2]!.at - left[1]!.at).toBeGreaterThanOrEqual(60_000);
    // the second's line was said again when the one ahead of it left: 1 ahead, then 0
    expect(r2.lines.map((l) => /(\d+) step\(s\) ahead/.exec(l)![1])).toEqual(["1", "0"]);
    expect(r3.lines.map((l) => /(\d+) step\(s\) ahead/.exec(l)![1])).toEqual(["2", "1", "0"]);
    expect(r1.events.map((e) => e.kind)).toEqual(["load.wait", "load.start"]);
  });

  test("BR-2630: a step that arrives while another waits queues behind it even when the load is low; one after a step that left the queue waits out the 60 seconds", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const a = request("C-9");
    const waiting = passLoadGate(deps(101), a.req);
    await settle();
    w.load = 12;
    const b = request("C-12");
    const behind = passLoadGate(deps(102), b.req);
    await Promise.all([waiting, behind]);
    expect(b.events.map((e) => e.kind)).toEqual(["load.wait", "load.start"]);
    expect(b.lines[0]).toContain("1 step(s) ahead");
    // C-12 just left the queue: a new step at a low load with an empty queue waits for the spacing
    const c = request("C-13");
    const later = passLoadGate(deps(103), c.req);
    await settle();
    expect(c.lines).toHaveLength(1);
    await later;
    expect(c.events.map((e) => e.kind)).toEqual(["load.wait", "load.start"]);
  });

  test("BR-2630: a step that left the queue 60 seconds ago does not hold the next one back", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const a = request("C-9");
    const waiting = passLoadGate(deps(101), a.req);
    await settle();
    w.load = 12;
    await waiting;
    w.now += 60_000;
    const b = request("C-10");
    expect(await passLoadGate(deps(102), b.req)).toEqual({ ok: true, value: "go" });
    expect(b.lines).toEqual([]);
    expect(b.events).toEqual([]);
  });

  test("BR-2630: a load that cannot be read counts as under the limit: an empty queue goes at once, a non-empty queue is still kept in order with the 60 seconds", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    w.load = undefined;
    expect(await passLoadGate(deps(101), request("C-9").req)).toEqual({ ok: true, value: "go" });
    // C-9 waits (load over the limit) and then the load cannot be read: C-12 queues behind it
    w.load = 17;
    const a = request("C-10");
    const first = passLoadGate(deps(102), a.req);
    await settle();
    w.load = undefined;
    const b = request("C-12");
    const second = passLoadGate(deps(103), b.req);
    const done: string[] = [];
    await Promise.all([first.then(() => done.push("C-10")), second.then(() => done.push("C-12"))]);
    expect(done).toEqual(["C-10", "C-12"]);
    expect(b.lines[0]).toContain("5-minute load unknown");
    expect(b.lines[0]).toContain("1 step(s) ahead");
  });

  test("BR-2630: a waiting step says its line again when the number ahead changes and, with nothing changed, at most every 5 minutes", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const a = request("C-9");
    const seen: number[] = [];
    let polls = 0;
    // each poll is 100 s of the shared clock: 5 minutes pass at the third
    const base = deps(101);
    const r = await passLoadGate({ ...base, sleep: async (ms) => { polls++; seen.push(a.lines.length); w.now += 100_000; void ms; } }, { ...a.req, aborted: () => polls >= 7 });
    expect(r).toEqual({ ok: true, value: "aborted" });
    // said once at the start, not again at 100 s and 200 s, again at 300 s, not at 400 s and 500 s, again at 600 s
    expect(seen).toEqual([1, 1, 1, 2, 2, 2, 3]);
  });

  test("BR-2630: a stopped step leaves the queue, runs nothing and the next one goes; a step whose process is gone is not counted", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    let stop = false;
    const a = request("C-9", { aborted: () => stop });
    const pending = passLoadGate(deps(101), a.req);
    await settle();
    expect(names(dir)).toHaveLength(1);
    stop = true;
    expect(await pending).toEqual({ ok: true, value: "aborted" });
    expect(names(dir)).toEqual([]);
    // a queue file whose process was killed stays on disk, and is not ahead of the next step
    const b = request("C-10");
    const killed = passLoadGate(deps(102), b.req);
    await settle();
    expect(names(dir)).toHaveLength(1);
    w.dead.add(102);
    w.load = 10;
    const c = request("C-11");
    const next = passLoadGate(deps(103), c.req);
    // the killed step's pending promise is abandoned: it is a different process in real life
    expect(await next).toEqual({ ok: true, value: "go" });
    void killed;
  });

  test("BR-2630: a queue file that cannot be read stops the step loudly instead of letting it jump the queue", async () => {
    const dir = tmp();
    const { deps } = world(dir);
    await Bun.write(join(dir, "000000000001-9.json"), "{not json");
    const r = await passLoadGate(deps(101), request("C-9").req);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain("cannot be read");
  });

  test("BR-2630: the queue file names the subject and worktree, so the same number in two repositories is told apart", async () => {
    const dir = tmp();
    const { w, deps } = world(dir);
    const one = passLoadGate(deps(101), request("C-9", { worktree: "/repo-a.worktrees/C-9" }).req);
    await settle();
    const two = passLoadGate(deps(102), request("C-9", { worktree: "/repo-b.worktrees/C-9" }).req);
    await settle();
    const waits = loadWaitsNow(deps(0));
    expect(waits.ok && waits.value.map((e) => e.worktree)).toEqual(["/repo-a.worktrees/C-9", "/repo-b.worktrees/C-9"]);
    w.load = 10;
    await Promise.all([one, two]);
  });
});
