import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../../workspace.ts";
import { readConfig, type Config } from "../../../config/config.ts";
import { testFilesFor } from "../../../knowledge/check/tests.ts";
import { git } from "../../../kernel/git.ts";
import type { Running } from "../outcome.ts";

/** Runs the floor in `cwd`, its whole output in the log `name`; `running` lets a signal stop it (BR-2014, BR-2099). */
export async function runFloor(ws: Workspace, say: Say, cwd: string, name: string, running: Running): Promise<{ code: number; log: string; tail: string }> {
  say(`floor: ${ws.config.floor}`);
  const log = join(dirname(ws.db.db.filename), "logs", name);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const proc = Bun.spawn(["sh", "-c", ws.config.floor!], { cwd, stdout: fd, stderr: fd });
  running.floor = proc;
  const code = await proc.exited;
  running.floor = undefined;
  closeSync(fd);
  return { code, log, tail: code === 0 ? "" : readFileSync(log, "utf8").split("\n").slice(-40).join("\n") };
}

/**
 * The paths `base..head` changes, when every one is under a `floor_skip_paths` entry and none is a test file
 * (BR-2164); undefined when the floor must run. Renames count on both sides (`--no-renames`).
 */
export function floorSkip(wt: string, base: string, head: string): { paths: string[]; under: string[] } | undefined {
  // reason: the config of the tree that is landing decides, not the one read when the workspace opened, before
  // the rebase onto a main that may have changed floor_skip_paths or tests (BR-2164, issue #40).
  const read = readConfig(wt);
  if (!read.ok) return undefined;
  const config = read.value;
  if (config.floorSkipPaths.length === 0) return undefined;
  const d = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, head);
  if (!d.ok) return undefined;
  const paths = d.value === "" ? [] : d.value.split("\n");
  const under = new Set<string>();
  for (const p of paths) {
    const entry = config.floorSkipPaths.find((e) => p === e || p.startsWith(`${e}/`));
    if (!entry) return undefined;
    under.add(entry);
  }
  const tests = new Set(testFilesFor(wt, config));
  if (paths.some((p) => tests.has(p) || isTestPath(config, p))) return undefined;
  return { paths, under: [...under].sort() };
}

/** Whether a path matches a configured `tests` glob, so a deleted test file counts too (BR-2164). */
function isTestPath(config: Config, path: string): boolean {
  return (config.tests ?? []).some((g) => new Bun.Glob(g).match(path));
}
