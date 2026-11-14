import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSync } from "node:fs";
import type { Workspace } from "../workspace.ts";
import { isGone, processOf } from "../claims/liveness.ts";
import { exitOf, follow, newRunDir, runProcess, startBackground, type BackgroundJob } from "../land/detach.ts";
import { EXIT } from "../../invocation/command.ts";

/**
 * `canon work test` runs in its own background process and the command only follows it (BR-2467), the way a landing does
 * (D-80): a tool's time limit, a hang-up or Ctrl-C ends the follower, never the run. Running `canon work test` again in the
 * same worktree follows the run still going, or prints one that ended while nothing followed it.
 */
export const TEST_RUN: BackgroundJob = { env: "CANON_TEST_RUN", command: ["work", "test"], noun: "test run", again: "canon work test", stop: "canon work test --stop", dirPrefix: "test-run" };

const SPAWN = "test.spawn";
const POLL_MS = 100;

interface Spawned {
  readonly ts: string;
  readonly dir: string;
  readonly starter: { pid: number; start: string } | undefined;
}

/** The latest test run started from this worktree (BR-2467). */
function lastSpawn(ws: Workspace): Spawned | undefined {
  const r = ws.db.db.query<{ ts: string; detail: string }, [string, string]>("SELECT ts, detail FROM events WHERE kind = ? AND worktree = ? ORDER BY id DESC LIMIT 1").get(SPAWN, ws.root);
  if (!r) return undefined;
  const d = JSON.parse(r.detail) as { run?: unknown; pid?: unknown; pid_start?: unknown };
  if (typeof d.run !== "string") return undefined;
  const starter = typeof d.pid === "number" && typeof d.pid_start === "string" ? { pid: d.pid, start: d.pid_start } : undefined;
  return { ts: r.ts, dir: d.run, starter };
}

type State = { readonly running: Spawned } | { readonly unseen: Spawned } | { readonly lost: Spawned } | { readonly none: true };

/** Whether the latest run still goes on, ended with nobody having printed its end, ended without a result, or is done with. */
function stateOf(s: Spawned | undefined): State {
  if (!s || !existsSync(s.dir)) return { none: true };
  if (exitOf(s.dir) !== undefined) return existsSync(join(s.dir, "seen")) ? { none: true } : { unseen: s };
  const proc = runProcess(s.dir);
  if (proc) return isGone(proc) === false ? { running: s } : existsSync(join(s.dir, "seen")) ? { none: true } : { lost: s };
  // reason: before its process is written down, a run whose starter is alive is still starting (as for a landing, BR-2392)
  return s.starter && isGone(s.starter) === false ? { running: s } : { none: true };
}

async function processOfRun(dir: string): Promise<ReturnType<typeof runProcess>> {
  for (let i = 0; i < 50; i++) {
    const p = runProcess(dir);
    if (p) return p;
    await Bun.sleep(POLL_MS);
  }
  return undefined;
}

/** `canon work test` without the background marker (BR-2467): follows, reports, or starts a run and follows it; returns its exit code. */
export async function testInBackground(ws: Workspace, args: readonly string[]): Promise<number> {
  // reason: deciding that no run goes on and recording the one about to start happen in one write transaction, so two
  // `canon work test` started together in one worktree start one run (BR-2467, as BR-2392 for landings)
  const decided = ws.db.db.transaction((): State | { readonly spawn: string; readonly lostBefore?: Spawned } => {
    const st = stateOf(lastSpawn(ws));
    if ("running" in st || "unseen" in st) return st;
    const dir = newRunDir(ws, TEST_RUN.dirPrefix);
    mkdirSync(dir, { recursive: true });
    const me = processOf(process.pid);
    ws.db.event(ws.actor, SPAWN, null, { run: dir, args, pid: me?.pid ?? null, pid_start: me?.start ?? null });
    return { spawn: dir, ...("lost" in st ? { lostBefore: st.lost } : {}) };
  }).immediate();
  if ("running" in decided) {
    writeSync(2, `canon: the test run started ${decided.running.ts} from this worktree is still running; following it instead of starting another\n`);
    const proc = await processOfRun(decided.running.dir);
    return follow(ws, decided.running.dir, proc ? { recorded: proc } : { over: true }, proc?.pid ?? null, TEST_RUN);
  }
  if ("unseen" in decided) {
    writeSync(2, `canon: the test run started ${decided.unseen.ts} from this worktree ended while nothing followed it; its output follows. Run canon work test again to test anew\n`);
    return follow(ws, decided.unseen.dir, { over: true }, null, TEST_RUN);
  }
  if ("spawn" in decided) {
    if (decided.lostBefore) {
      writeSync(2, `canon: the test run started ${decided.lostBefore.ts} from this worktree ended without recording a result (killed where no handler runs); starting a new one\n`);
      writeFileSync(join(decided.lostBefore.dir, "seen"), "");
    }
    const { dir, proc } = startBackground(ws, args, decided.spawn, TEST_RUN);
    return follow(ws, dir, { proc }, proc.pid, TEST_RUN);
  }
  return EXIT.ok;
}

/**
 * `canon work test --stop` (BR-2467): SIGTERM to this worktree's running test run, which stops its files as a signal does
 * (BR-2304), and follows it to its end. Its exit code; not found when no run goes on here.
 */
export async function stopTest(ws: Workspace): Promise<{ ok: true; code: number } | { ok: false; code: "not_found" | "io"; message: string }> {
  const st = stateOf(lastSpawn(ws));
  if (!("running" in st)) return { ok: false, code: "not_found", message: `no test run is going on in this worktree (${ws.root})` };
  const proc = await processOfRun(st.running.dir);
  if (!proc) return { ok: false, code: "not_found", message: `the test run started ${st.running.ts} has no process yet; try again in a moment` };
  try {
    process.kill(proc.pid, "SIGTERM");
  } catch (e) {
    return { ok: false, code: "io", message: `cannot signal the test run process ${proc.pid}: ${(e as Error).message}` };
  }
  return { ok: true, code: await follow(ws, st.running.dir, { recorded: proc }, proc.pid, TEST_RUN) };
}
