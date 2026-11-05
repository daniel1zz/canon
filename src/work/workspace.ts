import { userInfo } from "node:os";
import { CoordDb } from "./db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readConfig, type Config } from "../invocation/config.ts";
import { listWorktreesLocked, toplevel } from "../kernel/git.ts";

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

/**
 * Who is acting (BR-2023): `--as <name>` inside a Claude Code session makes it `agent:<session>:<name>`; else
 * CANON_ACTOR when set; inside a Claude Code session (CLAUDECODE=1) the agent named by its session id; otherwise
 * the OS user as a human. An agent is never recorded as a human.
 */
export function currentActor(env: Record<string, string | undefined> = process.env, as?: string): Result<string> {
  const inAgent = env["CLAUDECODE"] === "1";
  const explicit = env["CANON_ACTOR"]?.trim();
  const session = env["CLAUDE_CODE_SESSION_ID"]?.trim().slice(0, 8) || "unknown";
  if (as !== undefined) {
    if (!AS_NAME.test(as)) return err("invalid", `--as ${JSON.stringify(as)}: a name is letters, digits, - and _ only`);
    if (!inAgent) return err("invalid", "--as is only for agents running in a Claude Code session; it is not set outside one");
    if (explicit) return err("invalid", `--as ${as} and CANON_ACTOR=${explicit} both name the actor; give one of them`);
    return ok(`agent:${session}:${as}`);
  }
  if (explicit) {
    if (inAgent && !explicit.startsWith("agent:")) return err("invalid", `CANON_ACTOR=${explicit} inside a Claude Code session: an agent session can only act as agent:<name>`);
    return ok(explicit);
  }
  if (inAgent) return ok(`agent:${session}`);
  return ok(`human:${userInfo().username}`);
}

export function openWorkspace(cwd: string, as?: string): Result<Workspace> {
  const root = toplevel(cwd);
  if (!root.ok) return root;
  // reason: a bad --as is refused before the coordination DB is opened, so nothing is written (BR-2023)
  const actor = currentActor(process.env, as);
  if (!actor.ok) return actor;
  const config = readConfig(root.value);
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

/** Where a command prints progress for the agent or person running it. */
export type Say = (line: string) => void;
