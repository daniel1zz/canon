import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../kernel/git.ts";

/** The varlock schema whose presence at the tree's root turns secret management on (D-85). */
export const SCHEMA_FILE = ".env.schema";
const LOCAL_VARLOCK = "node_modules/.bin/varlock";
const INSTALL_HINT = "install it in the project (npm i -D varlock) or on PATH";
/** A varlock call resolves the schema (`exec()`, e.g. `sops decrypt`); one that hangs fails the landing instead of holding the turn. */
const VARLOCK_TIMEOUT_MS = 120_000;

export type SecretScan = { readonly ok: true; readonly scanned: number } | { readonly ok: false; readonly reason: "secret" | "environment"; readonly message: string };

/** One plaintext value varlock found: never the value itself, only where it is and which variable it belongs to. */
export interface SecretFinding {
  readonly path: string;
  readonly line: number;
  readonly name: string;
}

/**
 * BR-2407, BR-2408 (D-86): when the tree about to become main has `.env.schema`, the files this change added or
 * modified between `base` and `head` are scanned by varlock for plaintext sensitive values, before anything is
 * sent to a model. No schema: nothing runs.
 */
export async function scanSecrets(wt: string, base: string, head: string, env: Record<string, string | undefined> = process.env): Promise<SecretScan> {
  if (!existsSync(join(wt, SCHEMA_FILE))) return { ok: true, scanned: 0 };
  const diff = git(wt, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, head);
  if (!diff.ok) return { ok: false, reason: "environment", message: `secret scan: cannot list the changed files: ${diff.error.message}` };
  const files = diff.value.split("\0").filter((f) => f !== "");
  if (files.length === 0) return { ok: true, scanned: 0 };
  const bin = findVarlock(wt, env);
  if (!bin) return { ok: false, reason: "environment", message: `secret scan: ${SCHEMA_FILE} is present, but varlock is neither at ${LOCAL_VARLOCK} nor on PATH; ${INSTALL_HINT}` };
  const runEnv = { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
  // reason: with no key `varlock scan` reports nothing to scan for and exits 0, a silent pass; load fails loud instead (BR-2408)
  const load = await run([bin, "load", "--agent"], wt, runEnv);
  if (load.error) return { ok: false, reason: "environment", message: `secret scan: ${bin} load could not run: ${load.error}` };
  // reason: only stderr is shown; stdout carries the loaded (partly masked) values (BR-2408)
  if (load.exitCode !== 0) return { ok: false, reason: "environment", message: `secret scan: varlock cannot resolve ${SCHEMA_FILE} (varlock load exited ${load.exitCode}), so the changed files cannot be scanned:\n${tail(stripAnsi(load.stderr))}` };
  const scan = await run([bin, "scan", "--", ...files], wt, runEnv);
  if (scan.error) return { ok: false, reason: "environment", message: `secret scan: ${bin} scan could not run: ${scan.error}` };
  if (scan.exitCode === 0) return { ok: true, scanned: files.length };
  const findings = scan.exitCode === 1 ? parseFindings(`${scan.stdout}\n${scan.stderr}`, files) : [];
  // reason: varlock's own output quotes the start of each value, so it is never echoed, not even when it cannot be read (BR-2407, BR-2408)
  if (findings.length === 0) return { ok: false, reason: "environment", message: `secret scan: varlock scan exited ${scan.exitCode} without a finding canon could read; its output is not shown because it may contain secret values; run varlock scan on the changed files yourself` };
  const lines = findings.map((f) => `  ${f.path}:${f.line} ${f.name}`);
  return {
    ok: false,
    reason: "secret",
    message: `secret scan: ${findings.length} plaintext sensitive value(s) from ${SCHEMA_FILE} in the changed files (values not shown):\n${lines.join("\n")}\nremove each value from the file and its commits on this branch (read it through varlock instead, see the canon-secrets skill), then land again`,
  };
}

/** The tree's own varlock first, then the one on PATH (BR-2408). */
export function findVarlock(wt: string, env: Record<string, string | undefined>): string | undefined {
  const local = join(wt, LOCAL_VARLOCK);
  if (existsSync(local)) return local;
  return Bun.which("varlock", { PATH: env["PATH"] ?? "" }) ?? undefined;
}

/**
 * The `<path>:<line>:<column> <NAME>` lines of varlock 1.24's scan report, kept only when the path is one of the
 * scanned files, so a quoted code line can never pass as a finding and be printed.
 */
export function parseFindings(output: string, files: readonly string[]): SecretFinding[] {
  const scanned = new Set(files);
  const out: SecretFinding[] = [];
  for (const raw of stripAnsi(output).split("\n")) {
    const m = /^\s*(.+):(\d+):(\d+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(raw);
    if (!m || !scanned.has(m[1]!)) continue;
    out.push({ path: m[1]!, line: Number(m[2]), name: m[4]! });
  }
  return out;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-30).join("\n");
}

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: VARLOCK_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (p.signalCode) return { exitCode, stdout, stderr, error: `killed by ${p.signalCode} (timeout ${VARLOCK_TIMEOUT_MS / 1000}s)` };
    return { exitCode, stdout, stderr };
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: "", error: (e as Error).message };
  }
}
