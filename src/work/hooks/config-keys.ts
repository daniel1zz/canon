import { err, ok, type Result } from "../../kernel/result.ts";
import type { StepId } from "../../invocation/flow.ts";
import { configKey, type JsonSchema, optional } from "../../invocation/key.ts";
import { readPorts, type PortRange } from "./ports.ts";

export type HookEvent = "after_start" | "before_land" | "after_land" | "after_stop" | "after_green";
export const HOOK_EVENTS: readonly HookEvent[] = ["after_start", "before_land", "after_land", "after_stop", "after_green"];

/** The hook event each hook step of canon's flow runs (BR-2540). */
const HOOK_STEPS: Partial<Record<StepId, HookEvent>> = {
  "start.after_start": "after_start",
  "land.before_land": "before_land",
  "after.after_land": "after_land",
  // reason: canon starts no code review itself; a project runs one from after_land, so that hook is what makes the step run (BR-2540)
  "after.code_review": "after_land",
  "after.after_green": "after_green",
  "stop.after_stop": "after_stop",
};

function hookOf(step: StepId): HookEvent {
  const event = HOOK_STEPS[step];
  if (!event) throw new Error(`the hooks key names step ${step}, which runs no hook event`);
  return event;
}

/** A command: a string with something other than white space (readHooks rejects a blank one). */
const NON_BLANK: JsonSchema = { type: "string", pattern: "\\S" };

/** canon/config.yaml keys of the lifecycle hooks (D-2, D-3, C-135). */
export const hookKeys = {
  hooks: configKey<Readonly<Record<HookEvent, readonly string[]>>>({
    key: "hooks",
    doc: "Commands per lifecycle event, run in order; each event takes a command or a list of commands. after_green commands must be safe to run again: one can be cut off and is not rerun, the next pass runs them for a newer commit, possibly beside what the cut-off run left; act on CANON_GREEN and write files to a temporary name, then rename (BR-2222, D-55).",
    default: { after_start: [], before_land: [], after_land: [], after_stop: [], after_green: [] },
    schema: { type: ["object", "null"], additionalProperties: false, properties: Object.fromEntries(HOOK_EVENTS.map((e) => [e, { anyOf: [NON_BLANK, { type: "array", items: NON_BLANK }] }])), default: {} },
    read: readHooks,
    commands: (v) => Object.values(v).flat(),
    replaces: { after_land: "hooks.after_land" },
    flow: {
      steps: ["start.after_start", "land.before_land", "after.after_land", "after.code_review", "after.after_green", "stop.after_stop"],
      role: optional("这个事件不配命令"),
      idle: (v, step) => (v[hookOf(step)].length === 0 ? `hooks.${hookOf(step)} 没配命令` : undefined),
      part: hookOf,
    },
    listed: 70,
    checked: 170,
  }),
  ports: configKey<PortRange | undefined>({
    key: "ports",
    doc: "The range of ports, `<from>-<to>` such as 4100-4199, each change gets one of as CANON_PORT in setup and every hook; the same change keeps its port, two changes whose worktrees exist never share one, and a port something else listens on is skipped (BR-2267, BR-2288, D-41, D-48). Unset means no port.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: "^\\s*\\d+\\s*-\\s*\\d+\\s*$|^$" },
    read: readPorts,
    flow: {
      steps: ["start.worktree"],
      role: optional("不写：不分端口"),
    },
    listed: 75,
    checked: 175,
  }),
};

function readHooks(v: unknown): Result<Record<HookEvent, readonly string[]>> {
  const out: Record<HookEvent, string[]> = { after_start: [], before_land: [], after_land: [], after_stop: [], after_green: [] };
  if (v === null) return ok(out);
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`hooks` must be a mapping of event → command or list of commands");
  for (const [event, cmds] of Object.entries(v as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) return err("invalid", `unknown hook event \`${event}\` (known: ${HOOK_EVENTS.join(", ")})`);
    const list = typeof cmds === "string" ? [cmds] : cmds;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || x.trim() === "")) return err("invalid", `\`hooks.${event}\` must be a command or a list of commands`);
    out[event as HookEvent] = list as string[];
  }
  return ok(out);
}
