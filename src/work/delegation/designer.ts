import { err, ok, type Result } from "../../kernel/result.ts";
import { sessionActor, type AgentRuntime } from "../../kernel/agent.ts";
import type { CoordDb } from "../db.ts";
import type { Workspace } from "../workspace.ts";
import { launcherSubagent } from "../workspace.ts";
import { configAt } from "./delegate.ts";
import { delegationKeys } from "./config-keys.ts";
import { isWorker } from "./worker.ts";

/**
 * Workers that may design (BR-2633, D-162): the launcher sets `CANON_WORKER_PROFILE` in the worker's environment, the
 * session-start hook records it once, and `design_profiles` on main lists the profiles whose workers may open changes and
 * chores and land design documents. The environment of a later command is never read.
 */

export const PROFILE_ENV = "CANON_WORKER_PROFILE";

/** The session part of a worker's actor, `agent:<session>` (BR-2023): what the profile is recorded under. */
export const sessionOfWorker = (actor: string): string => actor.split(":").slice(0, 2).join(":");

/**
 * What the session-start hook records for the worker session it runs in (BR-2633): the profile the launcher named, or "no
 * profile" when it named none. Only the first record of a session is kept, and nothing else writes one. Returns whether a
 * record was written; nothing is recorded for a session that is not a worker (no `CANON_SUBAGENT`).
 */
export function recordWorkerProfile(db: CoordDb, runtime: AgentRuntime, sessionId: string, env: Readonly<Record<string, string | undefined>>, child?: string): Result<boolean> {
  const name = launcherSubagent(env);
  if (!name.ok) return name;
  const worker = child ?? name.value;
  if (worker === undefined) return ok(false);
  const session = sessionOfWorker(sessionActor(runtime, sessionId, worker));
  const profile = env[PROFILE_ENV]?.trim() || null;
  const wrote = db.db.transaction(() => {
    const done = db.db.query("INSERT OR IGNORE INTO worker_profiles(session, profile) VALUES (?, ?)").run(session, profile);
    if (done.changes === 0) return false;
    db.event(`${session}:${worker}`, "worker.profile", session, { session, profile });
    return true;
  }).immediate();
  return ok(wrote);
}

/** The profile recorded for the worker's session: undefined when none was recorded, null for "no profile". */
export function recordedProfile(db: CoordDb, actor: string): string | null | undefined {
  const row = db.db.query<{ profile: string | null }, [string]>("SELECT profile FROM worker_profiles WHERE session = ?").get(sessionOfWorker(actor));
  return row === null ? undefined : row.profile;
}

/** `design_profiles` as main has it (BR-2633): read from main, so a worker that adds itself on its own branch gains nothing. */
export function designProfilesOnMain(ws: Workspace): Result<readonly string[]> {
  const config = configAt(ws, ws.config.main);
  return delegationKeys.designProfiles.read(config["design_profiles"] ?? [], { root: ws.primary, raw: config });
}

/**
 * Whether the executor is a worker that may design: its session's recorded profile is in main's `design_profiles`. False for
 * anyone who is not a worker, and for a worker with no record or no profile. A `design_profiles` main cannot be read is an
 * error, so the command fails loudly instead of treating the worker as a plain one.
 */
export function mayDesign(ws: Workspace): Result<boolean> {
  if (!isWorker(ws.actor)) return ok(false);
  const profile = recordedProfile(ws.db, ws.actor);
  if (profile === undefined || profile === null) return ok(false);
  const listed = designProfilesOnMain(ws);
  if (!listed.ok) return err("invalid", `canon/config.yaml on ${ws.config.main}: ${listed.error.message}`);
  return ok(listed.value.includes(profile));
}
