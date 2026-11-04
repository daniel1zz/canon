/**
 * Stopping everything a signalled watcher started (BR-2285, issue #101): its setup, floor and after_green, the
 * processes those started, ones started meanwhile and ones whose parent already exited.
 */

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/** The live processes in the process table, without zombies and without the `ps` that read it; undefined when unreadable. */
function table(): Row[] | undefined {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,stat="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return undefined;
  }
  if (r.exitCode !== 0 || !r.stdout) return undefined;
  const rows: Row[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
    // reason: a zombie has ended and only waits to be reaped; the ps that printed the table is itself in the group (#101)
    if (stat === undefined || stat.startsWith("Z") || Number(pid) === r.pid) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) });
  }
  return rows;
}

/**
 * What `self` started that still runs. A watcher leads its own process group (canon starts it detached): then every
 * other process in the group, which takes in those whose parent exited, since they keep the group. Otherwise only its
 * descendants, parents listed before their children.
 */
function startedBy(rows: readonly Row[], self: number): number[] {
  if (rows.find((r) => r.pid === self)?.pgid === self) return rows.filter((r) => r.pgid === self && r.pid !== self).map((r) => r.pid);
  const out: number[] = [];
  const parents = [self];
  while (parents.length > 0) {
    const parent = parents.shift();
    for (const r of rows) {
      if (r.ppid !== parent) continue;
      out.push(r.pid);
      parents.push(r.pid);
    }
  }
  return out;
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // reason: it ended on its own meanwhile; nothing left to signal.
  }
}

/**
 * Sends SIGTERM to every process this process started (startedBy). They are first stopped with SIGSTOP, listing again
 * until no new one shows up, so none can start another between the listing and the signal; then each gets SIGTERM and
 * SIGCONT. What a TERM handler starts after that is its cleanup and is left to run. False when the process table cannot
 * be read at some point: what was stopped by then still gets SIGTERM and SIGCONT, but more may have been missed.
 */
export function stopStarted(self = process.pid): boolean {
  const stopped = new Set<number>();
  let read = true;
  for (;;) {
    const rows = table();
    // reason: a listing that fails after some were stopped must not leave them stopped for good (BR-2285, issue #106)
    if (!rows) {
      read = false;
      break;
    }
    const fresh = startedBy(rows, self).filter((p) => !stopped.has(p));
    if (fresh.length === 0) break;
    for (const p of fresh) {
      send(p, "SIGSTOP");
      stopped.add(p);
    }
  }
  for (const p of stopped) send(p, "SIGTERM");
  for (const p of stopped) send(p, "SIGCONT");
  return read;
}

/** How long a signalled watcher waits for what it started to end after SIGTERM before it sends SIGKILL (BR-2285). */
export const STOP_GRACE_MS = 10_000;

/**
 * Waits, blocking, until nothing this process started still runs, or `ms` passes. True when nothing is left; false when
 * something still runs, or the process table could not be read, when `ms` is over. It blocks on purpose: while it waits,
 * the watcher's own code must not go on to record a result or start the next command (#102).
 */
export function waitStarted(ms: number, self = process.pid): boolean {
  const end = Date.now() + ms;
  for (;;) {
    const rows = table();
    // reason: one listing that fails proves nothing has ended; the wait goes on to its end, so a TERM handler keeps its time (BR-2285, issue #108)
    if (rows && startedBy(rows, self).length === 0) return true;
    if (Date.now() >= end) return false;
    Bun.sleepSync(50);
  }
}

/** Sends SIGKILL to everything this process started, again for any that shows up meanwhile, until a listing finds none or `ms` passes. */
export function killStarted(ms: number, self = process.pid): boolean {
  const end = Date.now() + ms;
  for (;;) {
    const rows = table();
    if (!rows) return false;
    const left = startedBy(rows, self);
    if (left.length === 0) return true;
    if (Date.now() >= end) return false;
    for (const p of left) send(p, "SIGKILL");
    Bun.sleepSync(50);
  }
}

/**
 * Stops what this process started (BR-2285): SIGTERM through stopStarted, then waits up to STOP_GRACE_MS for all of
 * it to end, so a TERM handler can finish (an atomic replace, flushing output); what is still there then gets SIGKILL.
 * Returns what to say, or undefined when everything ended.
 */
export function stopAndWait(self = process.pid): string | undefined {
  if (!stopStarted(self)) return "cannot read the process table, so the commands this watcher started may not all have been stopped";
  if (waitStarted(STOP_GRACE_MS, self)) return undefined;
  const killed = killStarted(5_000, self);
  return `what this watcher started was still running ${STOP_GRACE_MS / 1000} s after SIGTERM; sent SIGKILL${killed ? "" : ", and some of it is still running"}`;
}
