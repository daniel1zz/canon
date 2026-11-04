import { cpus } from "node:os";

/**
 * Running several test files at once while the machine has room (BR-2302, BR-2303, D-56): how idle CPUs are measured,
 * and the pool that starts a file only while one is idle. It knows nothing of test commands: `run` is given.
 */

/** The `os.cpus()` time counters added up over all CPUs. */
export interface CpuSample {
  readonly idle: number;
  readonly total: number;
  /** How many CPUs the counters add up (`os.cpus().length`). */
  readonly count: number;
}

/** The CPU counters now, or undefined when `os.cpus()` lists no CPU. */
export function readCpu(): CpuSample | undefined {
  const list = cpus();
  if (list.length === 0) return undefined;
  let idle = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    // reason: iowait is not among the five counters, so on Linux it counts as neither idle nor busy (BR-2302)
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, count: list.length };
}

export type WindowKind = "idle" | "busy" | "stalled";

/**
 * Whether the window from `a` to `b` had at least 1 idle CPU (BR-2302): idle share times CPU count is at least 1,
 * compared on the integer counters (idle increase × count ≥ total increase); "stalled" when no counter advanced.
 */
export function judgeWindow(a: CpuSample, b: CpuSample): WindowKind {
  const total = b.total - a.total;
  if (total <= 0) return "stalled";
  return (b.idle - a.idle) * b.count >= total ? "idle" : "busy";
}

/** The most files at once for `test_jobs`: `auto` is half of the CPUs `parallelism` counts, at least 1 (BR-2302). */
export function jobCap(setting: number | "auto", parallelism: number): number {
  return setting === "auto" ? Math.max(1, Math.floor(parallelism / 2)) : setting;
}

/** What one run of a test file gave. */
export interface Outcome {
  readonly exitCode: number;
  readonly ms: number;
  /** Combined stdout and stderr. */
  readonly output: string;
  /** It ended because of SIGHUP, SIGINT or SIGTERM (BR-2304). */
  readonly signalled: boolean;
}

export interface FileResult extends Outcome {
  readonly file: string;
  /** Another file was running at some time while this one ran (BR-2303). */
  readonly overlapped: boolean;
}

export type CpuState = "ok" | "stalled" | "unreadable";

export interface PoolOptions {
  readonly files: readonly string[];
  /** The most files at once; 1 never measures. */
  readonly cap: number;
  readonly run: (file: string) => Promise<Outcome>;
  readonly readCpu: () => CpuSample | undefined;
  /** The window length: the shortest a window may be and the time between the timer's looks (BR-2302). */
  readonly tickMs: number;
  /** The CPU counters at the start of the run, undefined when they cannot be read (then it runs one at a time). */
  readonly first: CpuSample | undefined;
  /** True once a stop signal arrived (BR-2304): nothing new starts, a file that ended by a signal is not a failure. */
  readonly stopping: () => boolean;
  /** How long after a file ended by a signal a stop signal still counts for it (BR-2304). */
  readonly graceMs: number;
  /** Called once for each file that ended (not for one stopped by a signal), in the order they end. */
  readonly onEnd: (r: FileResult) => void;
  readonly say: (line: string) => void;
}

export interface PoolResult {
  readonly results: readonly FileResult[];
  readonly peak: number;
  readonly cpu: CpuState;
  readonly stalledWindows: number;
}

export interface Pool {
  readonly done: Promise<PoolResult>;
  /** Files running now, including ones that ended by a signal and are not counted as ended (BR-2304). */
  running(): number;
  /** The files that ended so far. */
  ended(): readonly FileResult[];
}

/** Runs `files` in order, the first at once and another only by the rule of BR-2302. */
export function startPool(o: PoolOptions): Pool {
  const cap = o.cap > 1 && !o.first ? 1 : o.cap;
  const results: FileResult[] = [];
  const running = new Map<string, { overlapped: boolean }>();
  let next = 0;
  let peak = 0;
  let stalledWindows = 0;
  let cpu: CpuState = o.cap > 1 && !o.first ? "unreadable" : "ok";
  let windowStart = o.first;
  let windowAt = performance.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let finish: (r: PoolResult) => void = () => {};

  const start = () => {
    const file = o.files[next++]!;
    const rec = { overlapped: running.size > 0 };
    for (const r of running.values()) r.overlapped = true;
    running.set(file, rec);
    peak = Math.max(peak, running.size);
    // reason: a file just started must show in the next window before another one is judged (BR-2302)
    windowStart = cap > 1 ? o.readCpu() : undefined;
    windowAt = performance.now();
    void o.run(file).then(async (out) => {
      // reason: whatever its exit code (a tool that traps SIGTERM and exits 1), a file that ends after the stop signal was running when it came (BR-2304)
      let stopped = o.stopping();
      if (out.signalled && !stopped) {
        await Bun.sleep(o.graceMs);
        stopped = o.stopping();
      }
      if (stopped) return; // stays in `running` for good, so the counts taken at the signal stay true (BR-2304)
      running.delete(file);
      const r: FileResult = { ...out, file, overlapped: rec.overlapped };
      results.push(r);
      o.onEnd(r);
      decide();
    });
  };

  const decide = () => {
    if (o.stopping()) {
      if (timer) clearInterval(timer);
      return;
    }
    if (next >= o.files.length) {
      if (running.size === 0) {
        if (timer) clearInterval(timer);
        finish({ results, peak, cpu, stalledWindows });
      }
      return;
    }
    if (running.size === 0) return start(); // reason: a run always has one file going, however busy the machine (BR-2302)
    if (cap <= 1 || running.size >= cap) return;
    if (performance.now() - windowAt < o.tickMs) return;
    const now = o.readCpu();
    const kind = windowStart && now ? judgeWindow(windowStart, now) : "stalled";
    // reason: a window with no advancing counter says nothing about the machine; say so once, never assume idle or busy (BR-2302)
    if (kind === "stalled") {
      if (stalledWindows++ === 0) o.say("CPU time counters did not advance in a 2 s window; no extra file is started in such windows");
      cpu = "stalled";
    }
    windowStart = now;
    windowAt = performance.now();
    if (kind === "idle") start();
  };

  const done = new Promise<PoolResult>((resolve) => {
    finish = resolve;
  });
  if (o.files.length === 0) finish({ results, peak, cpu, stalledWindows });
  else {
    if (cap > 1) timer = setInterval(decide, o.tickMs);
    decide();
  }
  return { done, running: () => running.size, ended: () => results };
}
