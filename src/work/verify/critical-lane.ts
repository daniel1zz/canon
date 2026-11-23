import { ok, type Result } from "../../kernel/result.ts";
import { changeStates } from "../../knowledge/changes/state.ts";
import { heldBy } from "../reminders/holds.ts";
import { mainCorpus } from "../session/session.ts";
import type { Workspace } from "../workspace.ts";

/**
 * The open changes waiting on `subject`, nearest first, when the critical-path lane applies to it (BR-2643): the project's
 * policies.capacity.critical_lane is on and others wait on it as the agenda counts them (BR-2635). Empty otherwise.
 */
export function criticalHolds(ws: Workspace, subject: string): Result<string[]> {
  if (!ws.config.capacityPolicy.critical_lane) return ok([]);
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const states = changeStates(ws, { corpus: corpus.value });
  if (!states.ok) return states;
  return ok(heldBy(states.value.states).get(subject) ?? []);
}
