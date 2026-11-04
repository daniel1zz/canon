/**
 * Stopping everything a signalled watcher started (BR-2219, BR-2270, issue #101): its setup, floor and after_green, the
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
 * be read, so nothing could be stopped.
 */
export function stopStarted(self = process.pid): boolean {
  const stopped = new Set<number>();
  for (;;) {
    const rows = table();
    if (!rows) return false;
    const fresh = startedBy(rows, self).filter((p) => !stopped.has(p));
    if (fresh.length === 0) break;
    for (const p of fresh) {
      send(p, "SIGSTOP");
      stopped.add(p);
    }
  }
  for (const p of stopped) send(p, "SIGTERM");
  for (const p of stopped) send(p, "SIGCONT");
  return true;
}
