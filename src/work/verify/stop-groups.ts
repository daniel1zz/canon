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
