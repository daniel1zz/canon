import { toplevel } from "../../kernel/git.ts";
import { readings } from "../delegation/capacity.ts";
import { openWorkspace, readWorkConfig } from "../workspace.ts";
import { machineLoad, wouldWait, type LoadDeps } from "./load-gate.ts";

/**
 * The heavy-command check of the Bash hook (BR-2631, D-161): while a heavy step would have to wait for the load, a Bash
 * command that matches `heavy_commands` and does not run as `canon heavy run …` is refused with the way to run it. It only
 * guides: it reads the command's text and nothing else, so a compound command or a script that runs a heavy command inside
 * is not recognised unless the project lists it.
 */

/** `canon heavy run` at the start of the command, after blanks and `NAME=value` assignments. */
const THROUGH_CANON = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S)*\s+)*canon\s+heavy\s+run(?:\s|$)/;

export const throughCanon = (command: string): boolean => THROUGH_CANON.test(command);

const HOW = (command: string) => `run it as: canon heavy run -- ${command.trim()}; a compound command goes in sh -c '…' (BR-2631)`;

/**
 * The reason to refuse `command` in `cwd`, or undefined to let it through. Nothing here fails the hook: a project without
 * canon, a configuration that cannot be read or a queue that cannot be read lets the command through (the commands of
 * canon report those themselves).
 */
export function heavyRefusal(command: string, cwd: string, load: LoadDeps = machineLoad, now: () => number = Date.now): string | undefined {
  const root = toplevel(cwd);
  if (!root.ok) return undefined;
  const config = readWorkConfig(root.value);
  if (!config.ok || config.value.heavyCommands.length === 0) return undefined;
  if (throughCanon(command)) return undefined;
  const matched = config.value.heavyCommands.find((p) => new RegExp(p).test(command));
  if (matched === undefined) return undefined;
  let machine: ReturnType<typeof readings>["machine"];
  let wait;
  try {
    machine = readings().machine;
    wait = wouldWait({ ...load, read: () => machine, now }, config.value.heavyMaxLoadPerCpu);
  } catch {
    return undefined;
  }
  if (!wait.ok || wait.value === undefined) return undefined;
  const w = wait.value;
  const why =
    w.reason === "load" ? `heavy command while 5-minute load is ${w.machine.load5.toFixed(1)} on ${w.machine.cpus} CPUs (limit ${w.limit})`
    : w.reason === "queue" ? `heavy command while ${w.ahead} heavy step(s) wait for the load`
    : "heavy command while the last heavy step left the load queue less than 60 seconds ago";
  const opened = openWorkspace(cwd);
  if (opened.ok) {
    // reason: the event carries the matched item and, when the load can be read, the load and the limit (BR-2631)
    const measured = machine ? { load: Math.round(machine.load5 * 10) / 10, limit: config.value.heavyMaxLoadPerCpu * machine.cpus, cpus: machine.cpus } : {};
    opened.value.db.event(opened.value.actor, "heavy.refuse", null, { matched, ...measured, ...(w.reason === "load" ? {} : w.reason === "queue" ? { ahead: w.ahead } : { spacing: true }) });
  }
  return `${why}; ${HOW(command)}`;
}
