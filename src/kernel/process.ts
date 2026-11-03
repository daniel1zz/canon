import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { err, ok, type Result } from "./result.ts";

/** A process whose current directory is inside a worktree: removing the worktree would pull it out from under it. */
export interface Occupant {
  readonly pid: number;
  readonly command: string;
}

/**
 * For each directory, the other processes whose current directory is it or below it. Read from /proc where it
 * exists, otherwise from `lsof -d cwd` (macOS). Failing to list processes is an error, never "nobody is there".
 */
export function processesIn(dirs: readonly string[]): Result<Map<string, Occupant[]>> {
  const cwds = listCwds();
  if (!cwds.ok) return cwds;
  const out = new Map<string, Occupant[]>();
  for (const dir of dirs) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // a directory that is already gone has nobody in it
    }
    out.set(dir, cwds.value.filter((c) => c.pid !== process.pid && (c.cwd === real || c.cwd.startsWith(`${real}/`))).map(({ pid, command }) => ({ pid, command })));
  }
  return ok(out);
}

function listCwds(): Result<{ pid: number; command: string; cwd: string }[]> {
  if (process.platform === "linux") {
    const out: { pid: number; command: string; cwd: string }[] = [];
    for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const cwd = readlinkSync(`/proc/${name}/cwd`);
        const command = readlinkSync(`/proc/${name}/exe`).split("/").pop() ?? "?";
        out.push({ pid: Number(name), command, cwd });
      } catch {
        // reason: processes of other users are unreadable and processes can exit mid-scan; neither can be in our worktree as us
      }
    }
    return ok(out);
  }
  let text: string;
  try {
    // reason: resolved against process.env's PATH, which Bun's own lookup does not always follow once it changes.
    const lsof = Bun.which("lsof", { PATH: process.env["PATH"] ?? "" });
    if (!lsof) return err("io", "cannot list processes: lsof is not on PATH");
    const r = Bun.spawnSync([lsof, "-w", "-d", "cwd", "-Fpcn"], { stdout: "pipe", stderr: "pipe" });
    text = r.stdout.toString();
    // reason: lsof exits 1 when some process could not be read, yet still lists the others.
    if (r.exitCode !== 0 && text === "") return err("io", `cannot list processes: lsof exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  } catch (e) {
    return err("io", `cannot list processes: lsof: ${(e as Error).message}`);
  }
  const out: { pid: number; command: string; cwd: string }[] = [];
  let pid = 0;
  let command = "?";
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n") && pid) out.push({ pid, command, cwd: line.slice(1) });
  }
  return ok(out);
}
