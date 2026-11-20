import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, fullRuns, machineDir, type Slot, type SlotDeps, type SlotRequest } from "./slot.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "canon-slot-"));

/** Deps of one fake process `pid` sharing `dir` with others; `dead` lists the pids the process table says are gone. */
function proc(dir: string, pid: number, dead: Set<number> = new Set()): SlotDeps {
  return { dir, pollMs: 10, now: Date.now, self: () => ({ pid, start: `start-${pid}` }), gone: (p) => dead.has(p.pid), sleep: (ms) => Bun.sleep(ms) };
}

function request(subject: string | null, over: Partial<SlotRequest> = {}) {
  const lines: string[] = [];
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  const req: SlotRequest = { subject, worktree: `/wt/${subject ?? "main"}`, kind: "work-test", max: 1, say: (l) => lines.push(l), aborted: () => false, record: (kind, detail) => events.push({ kind, detail }), ...over };
  return { req, lines, events };
}

async function take(d: SlotDeps, req: SlotRequest): Promise<Slot> {
  const r = await acquireSlot(d, req);
  if (!r.ok || r.value === "aborted") throw new Error(`no slot: ${JSON.stringify(r)}`);
  return r.value;
}

describe("a full test run queues machine-wide", () => {
  test("BR-2576: a second run waits behind the first, says one run is ahead and names it, and starts when the first ends", async () => {
    const dir = tmp();
    const a = request("C-1");
    const b = request("C-2");
    const slotA = await take(proc(dir, 101), a.req);
    expect(a.lines).toEqual([]);
    let bStarted = false;
    const pending = take(proc(dir, 102), b.req).then((s) => ((bStarted = true), s));
    await Bun.sleep(150);
    expect(bStarted).toBe(false);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toStartWith("canon: waiting for a full test run slot: 1 full run(s) ahead on this machine: C-1 (/wt/C-1, running 0 min)");
    expect(b.lines[0]).toContain("does not count toward test_timeout_minutes");
    slotA.release("passed");
    const slotB = await pending;
    expect(b.lines).toHaveLength(1);
    slotB.release("passed");
  });

  test("BR-2576: a barrier of five runs never lets two run at once, and they go in the order they queued", async () => {
    const dir = tmp();
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const runs = ["C-1", "C-2", "C-3", "C-4", "C-5"].map(async (name, i) => {
      await Bun.sleep(i * 30); // each queues after the one before it
      const slot = await take(proc(dir, 200 + i), request(name).req);
      running++;
      peak = Math.max(peak, running);
      order.push(name);
      await Bun.sleep(40);
      running--;
      slot.release("passed");
    });
    await Promise.all(runs);
    expect(peak).toBe(1);
    expect(order).toEqual(["C-1", "C-2", "C-3", "C-4", "C-5"]);
  });

  test("BR-2576: the waiting line lists every run ahead, a running one with its minutes and a waiting one as waiting; a change in the count prints another line", async () => {
    const dir = tmp();
    const a = await take(proc(dir, 301), request("C-1").req);
    const b = request("C-2");
    const c = request("C-3");
    const pb = take(proc(dir, 302), b.req);
    await Bun.sleep(60);
    const pc = take(proc(dir, 303), c.req);
    await Bun.sleep(150);
    expect(c.lines[0]).toStartWith("canon: waiting for a full test run slot: 2 full run(s) ahead on this machine: C-1 (/wt/C-1, running 0 min), C-2 (/wt/C-2, waiting);");
    a.release("passed");
    const sb = await pb;
    // reason: C-3 notices the count fall when C-1's entry goes, which can be before C-2 writes its start; wait for the line, not a fixed time (C-639)
    for (const until = Date.now() + 5000; c.lines.length < 2 && Date.now() < until; ) await Bun.sleep(20);
    expect(c.lines[1]).toContain("1 full run(s) ahead on this machine: C-2 (/wt/C-2, ");
    sb.release("passed");
    (await pc).release("passed");
  });

  test("BR-2576: a floor run is named main floor in the line of the run behind it", async () => {
    const dir = tmp();
    const floor = await take(proc(dir, 401), request(null, { kind: "floor", worktree: "/tmp/floor-wt" }).req);
    const b = request("C-9");
    const pb = take(proc(dir, 402), b.req);
    await Bun.sleep(100);
    expect(b.lines[0]).toContain("main floor (/tmp/floor-wt, running 0 min)");
    floor.release("passed");
    (await pb).release("passed");
  });

  test("BR-2576: a run stopped while it waits leaves the queue and the one behind it moves up", async () => {
    const dir = tmp();
    const a = await take(proc(dir, 501), request("C-1").req);
    let stop = false;
    const b = request("C-2", { aborted: () => stop });
    const pb = acquireSlot(proc(dir, 502), b.req);
    const pc = take(proc(dir, 503), request("C-3").req);
    await Bun.sleep(80);
    stop = true;
    const rb = await pb;
    expect(rb.ok && rb.value).toBe("aborted");
    a.release("passed");
    (await pc).release("passed");
    const left = await fullRuns(proc(dir, 999));
    expect(left.ok && left.value).toEqual([]);
  });

  test("BR-2579: with two slots the first two run together and the third waits for one of them", async () => {
    const dir = tmp();
    const two = (name: string) => request(name, { max: 2 });
    const a = await take(proc(dir, 601), two("C-1").req);
    const b = await take(proc(dir, 602), two("C-2").req);
    const c = two("C-3");
    const pc = take(proc(dir, 603), c.req);
    await Bun.sleep(100);
    expect(c.lines[0]).toContain("2 full run(s) ahead");
    a.release("passed");
    (await pc).release("passed");
    b.release("passed");
  });
});

describe("the queue lives in a state directory and forgets runs whose process is gone", () => {
  test("BR-2577: an entry whose process is gone is dropped, and the next run starts at once", async () => {
    const dir = tmp();
    const dead = new Set<number>();
    await take(proc(dir, 701, dead), request("C-1").req); // never released: its process dies
    dead.add(701);
    const b = request("C-2");
    await take(proc(dir, 702, dead), b.req);
    expect(b.lines).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  test("BR-2577: an entry whose process is alive keeps the next run waiting", async () => {
    const dir = tmp();
    await take(proc(dir, 711), request("C-1").req);
    const b = request("C-2");
    void take(proc(dir, 712), b.req);
    await Bun.sleep(100);
    expect(b.lines).toHaveLength(1);
  });

  test("BR-2577: a mutex left by a process that is gone is cleared", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".mutex"), { recursive: true });
    writeFileSync(join(dir, ".mutex", "owner"), JSON.stringify({ pid: 721, start: "start-721" }));
    const slot = await take(proc(dir, 722, new Set([721])), request("C-1").req);
    slot.release("passed");
  });

  test("BR-2577: a queue directory that cannot be made fails with an io error naming it", async () => {
    const dir = join(tmp(), "file");
    writeFileSync(dir, "x");
    const r = await acquireSlot(proc(dir, 731), request("C-1").req);
    expect(!r.ok && r.error.code).toBe("io");
    expect(!r.ok && r.error.message).toContain(dir);
  });

  test("BR-2577: the directory is CANON_MACHINE_DIR, else $XDG_STATE_HOME/canon, else ~/.local/state/canon", () => {
    expect(machineDir({ CANON_MACHINE_DIR: "/m", XDG_STATE_HOME: "/x" }, "/home/u")).toBe("/m");
    expect(machineDir({ XDG_STATE_HOME: "/x" }, "/home/u")).toBe("/x/canon");
    expect(machineDir({}, "/home/u")).toBe("/home/u/.local/state/canon");
  });
});

describe("a full run is recorded as events", () => {
  test("BR-2578: an immediate run records start and end only, the end with its duration and outcome", async () => {
    const dir = tmp();
    const a = request("C-1");
    const slot = await take(proc(dir, 801), a.req);
    slot.release("failed");
    slot.release("passed"); // once only
    expect(a.events.map((e) => e.kind)).toEqual(["test.full.start", "test.full.end"]);
    expect(a.events[0]!.detail).toEqual({ subject: "C-1", pid: 801, pid_start: "start-801" });
    expect(a.events[1]!.detail).toMatchObject({ subject: "C-1", pid: 801, pid_start: "start-801", outcome: "failed" });
    expect(typeof a.events[1]!.detail["duration_ms"]).toBe("number");
  });

  test("BR-2578: a queued run records wait with the runs ahead, then start, then end; the duration starts at start", async () => {
    const dir = tmp();
    const a = await take(proc(dir, 811), request("C-1").req);
    const b = request("C-2");
    const pb = take(proc(dir, 812), b.req);
    await Bun.sleep(120);
    a.release("passed");
    const sb = await pb;
    sb.release("stopped");
    expect(b.events.map((e) => e.kind)).toEqual(["test.full.wait", "test.full.start", "test.full.end"]);
    expect(b.events[0]!.detail).toEqual({ subject: "C-2", pid: 812, pid_start: "start-812", ahead: 1 });
    expect(b.events[2]!.detail["outcome"]).toBe("stopped");
    expect(b.events[2]!.detail["duration_ms"] as number).toBeLessThan(100);
  });

  test("BR-2578: the floor of main has no subject in its events", async () => {
    const dir = tmp();
    const f = request(null, { kind: "floor" });
    (await take(proc(dir, 821), f.req)).release("passed");
    expect(f.events.map((e) => e.detail["subject"])).toEqual([null, null]);
  });
});
