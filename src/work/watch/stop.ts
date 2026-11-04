/**
 * Stopping what a signalled watcher started (BR-2285, D-55): SIGTERM to its own process group when it leads one, as
 * canon always starts it; otherwise (run by hand from a shell without job control, whose group is not its own) SIGTERM
 * to its direct children. It does not wait: after_green must be safe to run again (BR-2222).
 */
export function stopStarted(self = process.pid): void {
  const pgid = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(self)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }).stdout.toString().trim();
  try {
    if (Number(pgid) === self) process.kill(-self, "SIGTERM");
    else Bun.spawnSync(["pkill", "-TERM", "-P", String(self)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // reason: nothing left to signal.
  }
}
