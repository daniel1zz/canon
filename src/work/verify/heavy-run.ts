import { constants } from "node:os";
import { err, ok, type Result } from "../../kernel/result.ts";
import { claimOfWorktree } from "../claims/claims.ts";
import type { Workspace } from "../workspace.ts";
import { heavyEnv, passHeavyStep } from "./heavy-step.ts";
import type { LoadDeps } from "./load-gate.ts";
import { groupAlive, stopGroups } from "./stop-groups.ts";

/**
 * `canon heavy run [--] <command> [args…]` (BR-2631, D-161): passes the load gate as a `heavy-run` step (BR-2630), then runs
 * the command in the foreground in a process group of its own, with `CANON_HEAVY_STEP=1` in its environment, so a heavy
 * step it starts does not wait on it again. A signal to canon is passed on to the whole group; the exit code is the
 * command's, or 128 plus the signal that ended it.
 */

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const codeOf = (sig: NodeJS.Signals): number => 128 + (constants.signals[sig] ?? 0);

export interface HeavyRunDeps {
  readonly load?: LoadDeps;
  readonly cwd?: string;
}

/** The exit code `canon heavy run` ends with, or an error that is the command's own (nothing to run, process table unreadable). */
export async function heavyRun(ws: Workspace, argv: readonly string[], say: (line: string) => void, deps: HeavyRunDeps = {}): Promise<Result<number>> {
  const [program, ...rest] = argv;
  if (program === undefined || program === "") return err("invalid", "canon heavy run needs a command: canon heavy run -- <command> [args…]; a compound command goes in sh -c '…' (BR-2631)");
  const subject = claimOfWorktree(ws.db, ws.root)?.subject ?? ws.actor;
  let stopped: NodeJS.Signals | undefined;
  const onWait = (sig: NodeJS.Signals) => {
    stopped = sig;
  };
  for (const s of SIGNALS) process.on(s, onWait);
  let passed: Awaited<ReturnType<typeof passHeavyStep>>;
  try {
    passed = await passHeavyStep(ws, { kind: "heavy-run", subject, worktree: ws.root, say, aborted: () => stopped !== undefined, ...(deps.load ? { deps: deps.load } : {}) });
  } finally {
    for (const s of SIGNALS) process.off(s, onWait);
  }
  if (!passed.ok) return passed;
  if (passed.value === "aborted") {
    say(`stopped by ${stopped!} while waiting for the machine load: the command did not run`);
    return ok(codeOf(stopped!));
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // reason: a process group of its own, so a signal reaches everything the command started (BR-2631)
    proc = Bun.spawn([program, ...rest], { cwd: deps.cwd ?? process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true, env: heavyEnv() });
  } catch (e) {
    return err("io", `canon heavy run: cannot start ${program}: ${(e as Error).message}`);
  }
  const forward = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      // reason: the group ended on its own meanwhile; nothing left to signal
    }
  };
  for (const s of SIGNALS) process.on(s, forward);
  const exit = await proc.exited;
  for (const s of SIGNALS) process.off(s, forward);
  // reason: nothing the command started is left running when canon heavy run ends (BR-2631)
  if (groupAlive(proc.pid)) await stopGroups([proc.pid], () => false);
  const sig = proc.signalCode;
  return ok(sig !== null ? codeOf(sig as NodeJS.Signals) : exit);
}
