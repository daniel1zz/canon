import { err, ok, type Result } from "../../kernel/result.ts";
import { isWorker } from "../delegation/worker.ts";
import { changeStatus } from "../land/queue/commands.ts";
import { redMain } from "../watch/redmain.ts";
import type { Workspace } from "../workspace.ts";
import { assignedTiers, BY_LABEL, clearTier, tierIndex, writeTier, type Assigned } from "./store.ts";
import { DEFAULT_TIER, type Tier } from "./tiers.ts";

/** What `canon priority set` was asked: a tier or --clear, by the main agent (a reason) or the owner (relayed words). */
export interface SetRequest {
  readonly change: string;
  /** undefined with --clear. */
  readonly tier: Tier | undefined;
  readonly by: "owner" | "main-agent";
  readonly words: string;
}

/** Why `canon priority set` refused, as the `priority.refuse` event records it (BR-2602). */
export type RefuseReason = "worker" | "p0-owner-only" | "owner-set" | "fix-main" | "closed";

/**
 * Sets or clears a change's tier (BR-2602, D-155). Every refusal exits 1, leaves the DB as it was and records
 * `priority.refuse` with its reason; a success records `priority.set`. Returns the line to print.
 */
export function setPriority(ws: Workspace, req: SetRequest): Result<string> {
  const refuse = (reason: RefuseReason, message: string, extra: Record<string, unknown> = {}): Result<string> => {
    ws.db.event(ws.actor, "priority.refuse", req.change, { reason, tier: req.tier ?? null, by: req.by, ...extra });
    return err("refused", `${message} (${reason})`);
  };
  if (isWorker(ws.actor)) return refuse("worker", `a worker cannot set a priority; ask the session that delegated ${req.change}`);
  if (redMain(ws.db)?.change === req.change) return refuse("fix-main", `${req.change} fixes the failing ${ws.config.main}: it is always P0 and its priority cannot be set`);
  const status = changeStatus(ws, req.change);
  if (!status.ok) return status;
  // reason: a change that landed or was dropped is not worked on again, so a tier on it would have no effect (BR-2602, BR-2603)
  if (status.value.status === "done" ? !status.value.canLand : status.value.status === "dropped") return refuse("closed", `${req.change} is ${status.value.status === "done" ? "landed" : "dropped"}; only an open change has a priority`, { status: status.value.status });
  if (req.by === "main-agent" && req.tier === "P0") return refuse("p0-owner-only", "only the owner sets P0 (relay their words with --relayed); the main agent sets P1 to P3");
  return ws.db.db
    .transaction((): Result<string> => {
      // reason: read inside the write transaction, so an owner's tier set meanwhile is not overwritten by a lower one (BR-2602)
      const now = assignedTiers(ws.db).get(req.change);
      const previous = now?.tier ?? DEFAULT_TIER;
      if (req.by === "main-agent" && now?.ownerTier) {
        const lower = req.tier === undefined || tierIndex(req.tier) > tierIndex(now.ownerTier);
        if (lower) return refuse("owner-set", `the owner set ${req.change} to ${now.ownerTier} ("${now.ownerWords ?? ""}"): the main agent may raise it, not ${req.tier === undefined ? "clear" : "lower"} it`, { owner_tier: now.ownerTier });
      }
      if (req.tier === undefined) clearTier(ws.db, req.change);
      else
        writeTier(ws.db, {
          change: req.change,
          tier: req.tier,
          by: req.by,
          words: req.words,
          actor: ws.actor,
          // reason: the owner's tier stays as the floor once the main agent raises it (BR-2602)
          ownerTier: req.by === "owner" ? req.tier : (now?.ownerTier ?? null),
          ownerWords: req.by === "owner" ? req.words : (now?.ownerWords ?? null),
        });
      const tier = req.tier ?? DEFAULT_TIER;
      ws.db.event(ws.actor, "priority.set", req.change, { tier, previous, by: req.by, ...(req.tier === undefined ? { cleared: true } : {}), ...(req.by === "owner" ? { relayed: req.words } : { reason: req.words }) });
      return ok(`${req.change}: ${tier} (${req.tier === undefined ? "cleared " : ""}by the ${req.by === "owner" ? "owner" : "main agent"}: ${req.words})`);
    })
    .immediate();
}

/** A tier's line in `canon work status`: `C-5      P1 by the main agent at <when>: <reason>` (BR-2603). */
export function priorityLine(a: Assigned): string {
  const who = a.by === "fix-main" ? "fix-main (fixes the failing main)" : `the ${BY_LABEL[a.by]}`;
  return `  ${a.change.padEnd(8)} ${a.tier} by ${who}${a.at ? ` at ${a.at}` : ""}${a.words !== null ? `: ${a.words}` : ""}${a.actor && a.by === "owner" ? ` (relayed by ${a.actor})` : ""}`;
}
