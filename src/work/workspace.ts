import { userInfo } from "node:os";
import { CoordDb } from "./db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { readConfig, type Config } from "../config/config.ts";
import { listWorktrees, toplevel } from "../kernel/git.ts";

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

/**
 * Who is acting (BR-2023): CANON_ACTOR when set; inside a Claude Code session (CLAUDECODE=1) the agent
 * named by its session id; otherwise the OS user as a human. An agent is never recorded as a human.
 *
 * A subagent's Bash calls carry `CANON_ACTOR=agent:<session>:<agent id>`, exported by `canon hook pre-bash`
 * (D-17). Such a value naming another session was inherited or copied, so it is refused instead of acting as
 * that session's subagent.
 */
export function currentActor(env: Record<string, string | undefined> = process.env): Result<string> {
  const inAgent = env["CLAUDECODE"] === "1";
  const explicit = env["CANON_ACTOR"]?.trim();
  const session = env["CLAUDE_CODE_SESSION_ID"]?.trim().slice(0, 8) ?? "";
  if (explicit) {
    if (inAgent && !explicit.startsWith("agent:")) return err("invalid", `CANON_ACTOR=${explicit} inside a Claude Code session: an agent session can only act as agent:<name>`);
    const sub = /^agent:([^:]*):/.exec(explicit);
    if (inAgent && session !== "" && sub && sub[1] !== session) {
      return err("invalid", `CANON_ACTOR=${explicit} names session ${sub[1]}, but this is Claude Code session ${session}: the value was inherited or copied from another session; unset it`);
    }
    return ok(explicit);
  }
  if (inAgent) return ok(`agent:${session || "unknown"}`);
  return ok(`human:${userInfo().username}`);
}

/** The session part of a subagent actor `agent:<session>:<agent id>`, or undefined for any other actor (D-17). */
export function parentActor(actor: string): string | undefined {
  const m = /^(agent:[^:]+):[^:]+$/.exec(actor);
  return m?.[1];
}

export function openWorkspace(cwd: string): Result<Workspace> {
  const root = toplevel(cwd);
  if (!root.ok) return root;
  const wts = listWorktrees(root.value);
  if (!wts.ok) return wts;
  const primary = wts.value[0]?.path;
  if (!primary) return err("io", "git reports no worktrees");
  const config = readConfig(root.value);
  if (!config.ok) return config;
  const dbPath = CoordDb.pathFor(root.value);
  if (!dbPath.ok) return dbPath;
  const db = CoordDb.open(dbPath.value);
  if (!db.ok) return db;
  const actor = currentActor();
  if (!actor.ok) return actor;
  return ok({ root: root.value, primary, db: db.value, config: config.value, actor: actor.value });
}

/** Where a command prints progress for the agent or person running it. */
export type Say = (line: string) => void;
