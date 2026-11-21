import { ok, type Result } from "../../kernel/result.ts";
import { liveClaim } from "../claims/claims.ts";
import { workerByEnv } from "../claims/as-hook.ts";
import { SUBAGENT_ENV, type Say, type Workspace } from "../workspace.ts";
import { delegate } from "./delegate.ts";
import { delegation } from "./records.ts";
import { isWorker } from "./worker.ts";

/**
 * BR-2610: whether `ws.actor` is a main session's own subagent (`agent:<session>:<name>`) starting `subject` while no
 * delegation is in force and no live claim binds it. A worker another session started (`CANON_SUBAGENT`, BR-2495, or
 * `CLAUDE_DELEGATE_CHILD=1`, BR-2468) claims only what was delegated to it, so it is never one.
 */
export function implicitEligible(ws: Workspace, subject: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!isWorker(ws.actor)) return false;
  if ((env[SUBAGENT_ENV] ?? "").trim() !== "" || workerByEnv(env)) return false;
  if (ws.actor.split(":")[1] === "unknown") return false;
  const d = delegation(ws.db, subject);
  if (d && d.ended === null) return false;
  return liveClaim(ws.db, subject) === undefined;
}

/**
 * Delegates `subject` to `ws.actor`'s name for its own session, the design owner, as `canon work delegate` would
 * (BR-2497), so the start that follows claims it like any delegated worker (BR-2498). The event says it was implicit.
 */
export function delegateImplicitly(ws: Workspace, subject: string, say: Say): Result<void> {
  const parts = ws.actor.split(":");
  const owner = parts.slice(0, 2).join(":");
  const made = delegate({ ...ws, actor: owner }, subject, parts.slice(2).join(":"), [], say, { by: ws.actor });
  if (!made.ok) return made;
  say(`${subject}: delegated for ${owner} to its subagent ${parts.slice(2).join(":")} (implicit, BR-2610)`);
  return ok(undefined);
}
