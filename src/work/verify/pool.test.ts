import { describe, expect, test } from "bun:test";
import { judgeWindow, jobCap, startPool, type CpuSample, type Outcome, type PoolOptions } from "./pool.ts";

const N = 8;
const sample = (idle: number, total: number): CpuSample => ({ idle, total, count: N });

/** Counters that advance by `total` per look, `idle` of it idle: a machine as idle or busy as asked. */
function machine(idlePerLook: number, totalPerLook = 800) {
  let idle = 0;
  let total = 0;
  let looks = 0;
  return {
    read: (): CpuSample => {
      looks++;
      idle += idlePerLook;
      total += totalPerLook;
      return sample(idle, total);
    },
    looks: () => looks,
  };
}

const done = (ms: number, exitCode = 0, signalled = false): Promise<Outcome> => Bun.sleep(ms).then(() => ({ exitCode, ms, output: "", signalled }));

function pool(over: Partial<PoolOptions> & Pick<PoolOptions, "files" | "cap" | "run">) {
  const lines: string[] = [];
  const ended: string[] = [];
  const m = machine(400);
  const first = over.first ?? m.read();
  const p = startPool({ readCpu: m.read, tickMs: 30, first, stopping: () => false, graceMs: 20, onEnd: (r) => ended.push(r.file), say: (l) => lines.push(l), ...over });
  return { p, lines, ended };
}

describe("canon work test idle CPUs", () => {
  test("BR-2302: a window needs at least 1 idle CPU, compared on the integer counters", () => {
    // 8 CPUs, total increase 800: exactly 1 CPU idle is idle share 100/800 times 8
    expect(judgeWindow(sample(0, 0), sample(100, 800))).toBe("idle");
    expect(judgeWindow(sample(0, 0), sample(99, 800))).toBe("busy");
    expect(judgeWindow(sample(0, 0), sample(800, 800))).toBe("idle");
    expect(judgeWindow(sample(0, 0), sample(0, 800))).toBe("busy");
  });

  test("BR-2302: counters that did not advance are stalled, not idle and not busy", () => {
    expect(judgeWindow(sample(5, 50), sample(5, 50))).toBe("stalled");
  });

  test("BR-2302: auto is half of the CPUs, at least 1; a number is the cap as written", () => {
    expect(jobCap("auto", 8)).toBe(4);
    expect(jobCap("auto", 4)).toBe(2);
    expect(jobCap("auto", 3)).toBe(1);
    expect(jobCap("auto", 1)).toBe(1);
    expect(jobCap(1, 8)).toBe(1);
    expect(jobCap(6, 2)).toBe(6);
  });
});

describe("canon work test pool", () => {
  test("BR-2302: on an idle machine files start one per window up to the cap", async () => {
    const { p } = pool({ files: ["a", "b", "c", "d", "e", "f"], cap: 3, run: () => done(400) });
    const r = await p.done;
    expect(r.peak).toBe(3);
    expect(r.results.map((x) => x.file).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(r.cpu).toBe("ok");
  });

  test("BR-2302: on a busy machine one file runs at a time, and the next starts as soon as one ends", async () => {
    const busy = machine(10);
    const order: string[] = [];
    const { p } = pool({ files: ["a", "b", "c"], cap: 4, readCpu: busy.read, first: busy.read(), run: (f) => (order.push(f), done(80)) });
    const r = await p.done;
    expect(r.peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("BR-2302: a cap of 1 never reads the CPU counters", async () => {
    const m = machine(800);
    const { p } = pool({ files: ["a", "b"], cap: 1, readCpu: m.read, first: undefined, run: () => done(10) });
    const r = await p.done;
    expect(r.peak).toBe(1);
    expect(m.looks()).toBe(0);
  });

  test("BR-2302: counters that cannot be read at the start mean one at a time and cpu unreadable", async () => {
    const { p } = pool({ files: ["a", "b", "c"], cap: 4, first: undefined, readCpu: () => undefined, run: () => done(60) });
    const r = await p.done;
    expect(r.peak).toBe(1);
    expect(r.cpu).toBe("unreadable");
  });

  test("BR-2302: a window whose counters do not advance starts nothing, says so once and records cpu stalled", async () => {
    const frozen = () => sample(100, 800);
    const { p, lines } = pool({ files: ["a", "b", "c"], cap: 3, readCpu: frozen, first: frozen(), run: () => done(200) });
    const r = await p.done;
    expect(r.peak).toBe(1);
    expect(r.cpu).toBe("stalled");
    expect(r.stalledWindows).toBeGreaterThan(1);
    expect(lines.filter((l) => l.startsWith("CPU time counters did not advance"))).toHaveLength(1);
  });

  test("BR-2302: the first file starts at once and at most one more starts per window", async () => {
    const started: number[] = [];
    const t0 = performance.now();
    const { p } = pool({ files: ["a", "b", "c", "d"], cap: 4, run: () => (started.push(performance.now() - t0), done(300)) });
    await p.done;
    expect(started[0]!).toBeLessThan(20);
    for (let i = 1; i < started.length; i++) expect(started[i]! - started[i - 1]!).toBeGreaterThanOrEqual(25); // a window is 30 ms here
  });

  test("BR-2302: a window that began at the last start is judged only once it is a full window long", async () => {
    // a ends at 100 ms and b starts at once (none was running), which restarts the window; the timer looks at 300 ms
    // and finds it 200 ms long, so c starts at the 600 ms look, not at 300 ms
    const startedAt = new Map<string, number>();
    const t0 = performance.now();
    const m = machine(800);
    const { p } = pool({ files: ["a", "b", "c"], cap: 2, tickMs: 300, readCpu: m.read, first: m.read(), run: (f) => (startedAt.set(f, performance.now() - t0), done(f === "a" ? 100 : 1000)) });
    await p.done;
    expect(startedAt.get("b")!).toBeLessThan(160);
    expect(startedAt.get("c")!).toBeGreaterThan(450);
  });

  test("BR-2304: a file that ended by a signal while stopping is neither ended nor a failure, and stays counted as running", async () => {
    let stop = false;
    const { p, ended } = pool({ files: ["a", "b"], cap: 2, stopping: () => stop, run: (f) => (f === "a" ? Bun.sleep(40).then(() => ({ exitCode: 130, ms: 40, output: "", signalled: true })) : done(500)) });
    setTimeout(() => (stop = true), 10);
    await Bun.sleep(150);
    expect(ended).toEqual([]);
    expect(p.running()).toBe(1); // a: b never started, as nothing starts after the signal
    expect(p.ended()).toEqual([]);
  });

  test("BR-2304: a stop signal within the grace time after a file ended by a signal still counts for it", async () => {
    let stop = false;
    const { p, ended } = pool({ files: ["a"], cap: 1, graceMs: 120, stopping: () => stop, run: () => Promise.resolve({ exitCode: 143, ms: 1, output: "", signalled: true }) });
    setTimeout(() => (stop = true), 50);
    await Bun.sleep(250);
    expect(ended).toEqual([]);
    expect(p.running()).toBe(1);
  });

  test("BR-2304: a file that ended by a signal with no stop signal is an ordinary failure", async () => {
    const { p, ended } = pool({ files: ["a"], cap: 1, run: () => Promise.resolve({ exitCode: 143, ms: 1, output: "", signalled: true }) });
    const r = await p.done;
    expect(ended).toEqual(["a"]);
    expect(r.results[0]!.exitCode).toBe(143);
  });

  test("BR-2303: a file is marked overlapped when another ran at any time while it did, in either order", async () => {
    const { p } = pool({ files: ["a", "b", "c"], cap: 2, tickMs: 20, run: (f) => done(f === "c" ? 20 : 150) });
    const r = await p.done;
    const by = Object.fromEntries(r.results.map((x) => [x.file, x.overlapped]));
    expect(by["a"]).toBe(true); // b started while a ran
    expect(by["b"]).toBe(true);
  });

  test("BR-2303: a file that ran alone is not overlapped", async () => {
    const { p } = pool({ files: ["a", "b"], cap: 1, run: () => done(20) });
    const r = await p.done;
    expect(r.results.map((x) => x.overlapped)).toEqual([false, false]);
  });
});
