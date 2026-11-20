/**
 * Stopping what `canon work test` started (BR-2304, D-56, D-55): every command runs in a process group of its own, so a
 * stop is a signal to each group, with no process table to read. Processes that left their group (`setsid`, `setpgid`)
 * and the leftovers of a canon that was itself killed with SIGKILL are not reached, as D-55 accepts for the watcher.
 */

/** How long a stop waits for the groups to end after SIGTERM, and then after SIGKILL (BR-2304). */
export const TERM_WAIT_MS = 10_000;
export const KILL_WAIT_MS = 5_000;

/** True while any process is left in the group `pid` leads. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drops the groups with no process left; a group whose leader ended but left a child running stays. */
export function forgetEnded(groups: Set<number>): void {
  for (const g of [...groups]) if (!groupAlive(g)) groups.delete(g);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // reason: the group ended on its own meanwhile; nothing left to signal.
  }
}

/**
 * SIGTERM to each group, then waits until none is left; at `termWaitMs`, or as soon as `hurried()` is true (a second
 * signal), what is left gets SIGKILL, and a further `killWaitMs` is waited. Returns a line to print when something was
 * killed or is still running, undefined when everything ended after SIGTERM.
 */
export async function stopGroups(pids: readonly number[], hurried: () => boolean, termWaitMs = TERM_WAIT_MS, killWaitMs = KILL_WAIT_MS): Promise<string | undefined> {
  for (const p of pids) signalGroup(p, "SIGTERM");
  const termEnd = Date.now() + termWaitMs;
  while (pids.some(groupAlive) && Date.now() < termEnd && !hurried()) await Bun.sleep(50);
  if (!pids.some(groupAlive)) return undefined;
  const why = hurried() ? "after a second signal" : `${termWaitMs / 1000} s after SIGTERM`;
  const killEnd = Date.now() + killWaitMs;
  while (pids.some(groupAlive) && Date.now() < killEnd) {
    for (const p of pids) if (groupAlive(p)) signalGroup(p, "SIGKILL");
    await Bun.sleep(50);
  }
  const left = pids.filter(groupAlive).length;
  return left === 0 ? `sent SIGKILL ${why}` : `sent SIGKILL ${why}, and ${left} process group(s) still run`;
}

/**
 * The groups among `pids` that have a process other than a zombie, from one `ps`; undefined when `ps` cannot be read.
 * reason: a group leader this process started stays a zombie until the event loop reaps it, which a blocking wait never
 * lets happen, and `kill(-group, 0)` counts the zombie: the wait would last until SIGKILL for a group already ended (#262).
 */
function liveGroups(pids: readonly number[]): Set<number> | undefined {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pgid=,stat="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  if (r.exitCode !== 0) return undefined;
  const wanted = new Set(pids);
  const live = new Set<number>();
  for (const line of r.stdout.toString().split("\n")) {
    const [pgid, stat] = line.trim().split(/\s+/);
    if (pgid !== undefined && stat !== undefined && !stat.startsWith("Z") && wanted.has(Number(pgid))) live.add(Number(pgid));
  }
  return live;
}

/**
 * The blocking form of stopGroups, for callers that cannot await: a signal handler that exits right after (BR-2099) or
 * a synchronous command (BR-2260). SIGTERM to each group, waits up to `termWaitMs` for them to end, then SIGKILL to what
 * is left and up to `killWaitMs` more. Returns whether SIGKILL was sent and the groups that still have a process.
 */
export function stopGroupsSync(pids: readonly number[], termWaitMs = TERM_WAIT_MS, killWaitMs = KILL_WAIT_MS): { readonly killed: boolean; readonly left: number[] } {
  // reason: without ps, kill(-group, 0) decides alone; a zombie leader then counts as running, which only makes the wait
  // longer and the report say a group is left; canon work land --stop checks again once this process is gone (BR-2393)
  const alive = (): number[] => {
    const live = liveGroups(pids);
    return pids.filter((p) => groupAlive(p) && (live === undefined || live.has(p)));
  };
  for (const p of pids) signalGroup(p, "SIGTERM");
  for (let end = Date.now() + termWaitMs; alive().length > 0 && Date.now() < end; ) Bun.sleepSync(50);
  if (alive().length === 0) return { killed: false, left: [] };
  for (let end = Date.now() + killWaitMs; alive().length > 0 && Date.now() < end; Bun.sleepSync(50)) for (const p of alive()) signalGroup(p, "SIGKILL");
  return { killed: true, left: alive() };
}

/** stopGroupsSync for one group, with a shorter wait for SIGTERM (BR-2260). */
export function stopGroupSync(pid: number, termWaitMs = 2_000, killWaitMs = KILL_WAIT_MS): void {
  stopGroupsSync([pid], termWaitMs, killWaitMs);
}
