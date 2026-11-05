import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "./workspace.ts";
import { git } from "../kernel/git.ts";
import { start } from "./session/session.ts";

/** Fixtures shared by the work and hook tests: throwaway repositories and workspaces. */
export const quiet = () => {};
export const FAST = { finish: false, timeoutMs: 20_000 };

export function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/**
 * A repo whose floor passes unless a file named FAIL exists in the tree. It opts out of the rule review on purpose
 * (`review: none`): unset would refuse every landing that changes a rule (BR-2074); tests of the review set their own.
 */
export function project(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-work-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: none\n");
  writeFileSync(join(root, "app.txt"), "one\ntwo\nthree\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "init");
  return root;
}

export function ws(cwd: string, actor = "agent:a"): Workspace {
  process.env["CANON_ACTOR"] = actor;
  const r = openWorkspace(cwd);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Starts a change and fills its required sections, as an agent must before landing (BR-2035, BR-2091). */
export function startNew(root: string, title: string, actor = "agent:a") {
  const r = start(ws(root, actor), { title }, quiet);
  if (!r.ok) throw new Error(r.error.message);
  const dir = join(r.value.worktree, "canon/changes");
  const file = readdirSync(dir).find((f) => f.startsWith(`${r.value.change}-`) || f === `${r.value.change}.md`)!;
  const text = readFileSync(join(dir, file), "utf8");
  writeFileSync(join(dir, file), text.slice(0, text.indexOf("---\n", 4) + 4) + `\n## 为什么\n\n${title}.\n\n## 要改什么\n\n${title}.\n\n## 教训\n\n无。\n\n## 任务\n\n- [ ] ${title}\n`);
  sh(r.value.worktree, "commit", "-q", "--amend", "--no-edit", "-a");
  return r.value;
}


/**
 * A reference-transaction hook that, the first time a ref of `wt` moves to `to`, runs `git commit -qam fix` in `wt`
 * right then, as a session committing in the worktree at that moment would; returns the file its output goes to.
 */
export function gapCommit(root: string, wt: string, to: string): string {
  const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
  mkdirSync(hooks, { recursive: true });
  const out = join(root, "..", `${root.split("/").pop()}-gap-commit`);
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q " ${to} " || exit 0\n[ -e ${out} ] && exit 0\ncd ${wt} && env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE git commit -qam fix > ${out} 2>&1\necho "exit $?" >> ${out}\n`,
    { mode: 0o755 },
  );
  return out;
}

/**
 * Longest a shell loop in a test fixture lives. A test that fails or times out is cleaned up by `reaper`, but a runner
 * killed with SIGKILL runs nothing, so this bound is what ends the loops it leaves behind (C-329, issues #119 #120).
 */
export const LOOP_SECONDS = 60;

/** A shell loop that waits while `cond` holds and ends by itself after LOOP_SECONDS. */
export const boundedLoop = (cond: string, step = 0.05) =>
  `__n=0; while ${cond} && [ $__n -lt ${Math.round(LOOP_SECONDS / step)} ]; do sleep ${step}; __n=$((__n + 1)); done`;

/** A fixture command that runs until the test ends it, but at most LOOP_SECONDS. */
export const runsUntilKilled = boundedLoop("true", 0.1);

/**
 * Remembers the processes and process groups a test starts so `killAll` (call it from afterEach, which runs after a
 * failing test too) ends them with SIGKILL. A group is killed as a whole, which also reaches what its members left
 * running after their parent exited.
 */
export function processReaper() {
  const groups = new Set<number>();
  const pids = new Set<number>();
  const kill = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  return {
    /** A process started with `detached: true` leads its own group; returns pid. */
    group(pid: number): number {
      if (pid === process.pid || pid <= 1) throw new Error(`refusing to register pid ${pid} as a group to kill`);
      groups.add(pid);
      return pid;
    },
    pid(pid: number): number {
      pids.add(pid);
      return pid;
    },
    killAll() {
      for (const g of groups) kill(-g);
      for (const p of pids) kill(p);
      groups.clear();
      pids.clear();
    },
  };
}

/**
 * How many seconds a fake long-running process lives. It is longer than any test timeout (90 s at most), so a fake
 * never ends by itself while a test runs: it ends only when the test or the code under test kills it. It is finite so
 * that a runner killed with SIGKILL, which runs no cleanup, leaves nothing behind for long (C-374, #126).
 */
export const HANG_SECONDS = 120;

const hung = new Set<{ kill: (signal: "SIGKILL") => void }>();
// reason: registered once per test file that imports this module; afterEach runs after a failing test too (C-374, #126)
afterEach(() => {
  for (const p of hung) p.kill("SIGKILL");
  hung.clear();
});

/** A live process that does nothing until it is killed; killed in afterEach at the latest. `cwd` puts it inside a directory. */
export function hang(opts: { cwd?: string } = {}) {
  const p = Bun.spawn(["sleep", String(HANG_SECONDS)], { stdout: "ignore", stderr: "ignore", stdin: "ignore", ...opts });
  hung.add(p);
  return p;
}

/** True while a process with this pid exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until process `pid` is gone, for at most `ms` (default 5 s), and fails at once with a clear message when it is
 * not: a process that should have been killed must not be waited for until the 30 s test timeout (C-374, #126).
 */
export async function waitGone(pid: number, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) throw new Error(`${what}: process ${pid} still running ${ms} ms after it should have been killed`);
    await Bun.sleep(20);
  }
}

/** Waits until `ready()` is true, polling every 10 ms, for at most `ms`; fails with `what` instead of waiting for the test timeout. */
export async function waitFor(what: string, ready: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(10);
  }
}
