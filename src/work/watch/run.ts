import { writeSync } from "node:fs";

/** Runs `command` in `cwd` with its output appended to the log behind `fd`. */
export async function runLogged(command: string, cwd: string, fd: number, env?: Record<string, string>): Promise<number> {
  writeSync(fd, `$ ${command}\n`);
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: fd, stderr: fd, stdin: "ignore", ...(env ? { env: { ...(process.env as Record<string, string>), ...env } } : {}) });
  return await proc.exited;
}

/** One shell word. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
