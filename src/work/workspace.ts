import { effectiveAgentSession } from "./agent-session.ts";
import { userInfo, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "./db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readConfig, type Config } from "../invocation/config.ts";
import { git, listWorktreesLocked, toplevel } from "../kernel/git.ts";
import { agentSession, sessionActor } from "../kernel/agent.ts";

/**
 * Everything a command needs: which worktree it runs in, where the primary checkout is, the shared
 * coordination DB, the project config, and who is acting.
 */
export interface Workspace {
  /** Toplevel of the worktree the command runs in; knowledge files are read and written here. */
  readonly root: string;
  /** The primary checkout (first entry of `git worktree list`); new worktrees are created under it. */
  readonly primary: string;
  readonly db: CoordDb;
  readonly config: Config;
  readonly actor: string;
}

/** What `--as` may be: a Claude Code agent id or any other plain name (BR-2023). */
const AS_NAME = /^[A-Za-z0-9_-]+$/;

/** The environment variable a launcher sets on a worker session it starts: the worker's name (BR-2495, D-125). */
export const SUBAGENT_ENV = "CANON_SUBAGENT";

/** The worker name the launcher set, undefined when it set none; an invalid one is an error (BR-2495). */
export function launcherSubagent(env: Record<string, string | undefined>): Result<string | undefined> {
  const name = env[SUBAGENT_ENV]?.trim();
  if (!name) return ok(undefined);
  return AS_NAME.test(name) ? ok(name) : err("invalid", `${SUBAGENT_ENV}=${JSON.stringify(name)}: a worker name is letters, digits, - and _ only`);
}

/** BR-2023: explicit override, otherwise host session/child identity, otherwise the OS user; a launcher's CANON_SUBAGENT acts as --as (BR-2495). */
export function currentActor(env: Record<string, string | undefined> = process.env, given?: string, cwd = process.cwd()): Result<string> {
  if (given !== undefined && !AS_NAME.test(given)) return err("invalid", `--as ${JSON.stringify(given)}: a name is letters, digits, - and _ only`);
  const launched = launcherSubagent(env);
  if (!launched.ok) return launched;
  // reason: the launcher names its worker once, so every canon command of that worker is recorded under the name without the worker passing --as (BR-2495, D-125)
  if (launched.value !== undefined && given !== undefined && given !== launched.value) return err("invalid", `--as ${given} does not match ${SUBAGENT_ENV}=${launched.value} that started this worker; pass no --as or --as ${launched.value}`);
  if (launched.value !== undefined && env["CANON_ACTOR"]?.trim()) return err("invalid", `${SUBAGENT_ENV}=${launched.value} and CANON_ACTOR=${env["CANON_ACTOR"]!.trim()} both name the actor; a launcher sets only ${SUBAGENT_ENV}`);
  const as = given ?? launched.value;
  const override = env["CANON_ACTOR"]?.trim();
  if (override && as === undefined) {
    const host = agentSession(env);
    if (host && !override.startsWith("agent:")) return err("invalid", `CANON_ACTOR=${override} inside a ${host.runtime === "codex" ? "Codex" : "Claude Code"} session: an agent session can only act as agent:<name>`);
    return ok(override);
  }
  const resolved = effectiveAgentSession(env, cwd);
  if (!resolved.ok) return resolved;
  const session = resolved.value;
  const inAgent = session !== undefined;
  const explicit = env["CANON_ACTOR"]?.trim();
  if (as !== undefined) {
    if (!AS_NAME.test(as)) return err("invalid", `--as ${JSON.stringify(as)}: a name is letters, digits, - and _ only`);
    if (!session) return err("invalid", given === undefined ? `${SUBAGENT_ENV} is only for workers running in a Claude Code or Codex session; it is set outside one` : "--as is only for agents running in a Claude Code or Codex session; it is not set outside one");
    if (explicit) return err("invalid", `--as ${as} and CANON_ACTOR=${explicit} both name the actor; give one of them`);
    if (session.runtime === "codex" && session.child && session.child !== as) return err("invalid", `--as ${as} does not match this Codex subagent's thread id ${session.child}`);
    return ok(sessionActor(session.runtime, session.id, as));
  }
  if (explicit) {
    if (inAgent && !explicit.startsWith("agent:")) return err("invalid", `CANON_ACTOR=${explicit} inside a ${session.runtime === "codex" ? "Codex" : "Claude Code"} session: an agent session can only act as agent:<name>`);
    return ok(explicit);
  }
  if (session) return ok(sessionActor(session.runtime, session.id, session.child));
  return ok(`human:${userInfo().username}`);
}

export function openWorkspace(cwd: string, as?: string, env: Record<string, string | undefined> = process.env): Result<Workspace> {
  const root = toplevel(cwd);
  if (!root.ok) return root;
  // reason: a bad --as is refused before the coordination DB is opened, so nothing is written (BR-2023)
  const actor = currentActor(env, as, root.value);
  if (!actor.ok) return actor;
  const config = readWorkConfig(root.value);
  if (!config.ok) return config;
  const dbPath = CoordDb.pathFor(root.value);
  if (!dbPath.ok) return dbPath;
  const db = CoordDb.open(dbPath.value, root.value);
  if (!db.ok) return db;
  // reason: after the coordination DB, so an unusable .git/canon is reported as the DB's (BR-2209); the lock file lives there too
  const wts = listWorktreesLocked(root.value);
  if (!wts.ok) return wts;
  const primary = wts.value[0]?.path;
  if (!primary) return err("io", "git reports no worktrees");
  return ok({ root: root.value, primary, db: db.value, config: config.value, actor: actor.value });
}

export function readWorkConfig(root: string): Result<Config> {
  if (existsSync(join(root, "canon/config.yaml"))) return readConfig(root);
  const branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (!branch.ok || !branch.value.startsWith("chore/")) return readConfig(root);
  // reason: BR-2278 — the old blob identifies main; only main's current configuration selects the retry gates.
  const seed = configFromHistory(root, "HEAD");
  if (!seed.ok) return seed;
  return configFromHistory(root, `refs/heads/${seed.value.main}`);
}

function configFromHistory(root: string, ref: string): Result<Config> {
  let text = git(root, "show", `${ref}:canon/config.yaml`);
  if (!text.ok) {
    const deleted = git(root, "log", "-1", "--format=%H", "--diff-filter=D", ref, "--", "canon/config.yaml");
    if (!deleted.ok) return deleted;
    if (deleted.value === "") return err("io", `${ref}: cannot recover canon/config.yaml; no configuration deletion is recorded`);
    text = git(root, "show", `${deleted.value}^:canon/config.yaml`);
    if (!text.ok) return text;
  }
  const dir = mkdtempSync(join(tmpdir(), "canon-main-config-"));
  try {
    mkdirSync(join(dir, "canon"));
    writeFileSync(join(dir, "canon/config.yaml"), text.value);
    return readConfig(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Where a command prints progress for the agent or person running it. */
export type Say = (line: string) => void;
