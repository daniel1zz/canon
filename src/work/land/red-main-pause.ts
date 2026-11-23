import { fixLandedIn, redMain } from "../watch/redmain.ts";
import { git } from "../../kernel/git.ts";
import { configAt } from "../delegation/delegate.ts";
import { landingPolicyOf } from "./config-keys.ts";
import type { Workspace } from "../workspace.ts";

/**
 * Why this landing waits for main to pass again (BR-2644), or undefined when it may go on: main's background floor is
 * failing, main's policies.landing.pause_on_red_main is on, this is not the fix change, and the fix change has not landed.
 */
export function redMainPause(ws: Workspace, wt: string, main: string, subject: string | null): string | undefined {
  const red = redMain(ws.db);
  if (!red) return undefined;
  const policy = landingPolicyOf(configAt(ws, main), wt);
  // reason: a config main cannot read is said, never taken as the pause being off (BR-2644)
  if (!policy.ok) return `canon/config.yaml on ${main} cannot be read for policies.landing: ${policy.error.message}`;
  if (!policy.value.pause_on_red_main) return undefined;
  if (red.change !== null && subject === red.change) return undefined;
  // reason: once the fix is on main the next background floor decides; landings need not wait for it (BR-2644)
  const tip = git(ws.primary, "rev-parse", main);
  if (red.change !== null && tip.ok && fixLandedIn(ws, tip.value)) return undefined;
  const files = red.files.length > 0 ? `failing test files: ${red.files.join(", ")}` : red.filesUnknown === "before-tests" ? "it failed before the tests ran" : "no failing test file was reported";
  const fix = red.change !== null ? `the fix is ${red.change}, not landed yet; land after it` : "nobody is fixing it yet: canon work start --fix-main";
  return `main is failing its background floor since ${red.first_sha.slice(0, 9)} (now ${red.sha.slice(0, 9)}; ${files}; log: ${red.log}); landing waits until it is fixed (BR-2644): ${fix}. A project turns this off with policies.landing.pause_on_red_main: false`;
}
