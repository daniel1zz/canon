import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { symlinkOnPath } from "./install.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * The entries canon merges into a project's `.claude/settings.json` (D-10). canon owns only these entries and
 * never touches anything else in that file. None of them blocks anything (D-1: no hook checks how an agent works).
 *
 *   SessionStart  `canon brief || echo ...`: a new session learns what it is working on (BR-2087)
 *   PreToolUse    `canon hook pre-bash`: a subagent's Bash calls carry its own actor (BR-2127, D-17)
 *   allow rule    the one export line that hook adds runs without a permission prompt (BR-2128)
 */
/**
 * `|| echo` keeps the session informed when brief fails or canon is not on PATH: a failing hook's stdout is not
 * shown to the model, and the echo makes the line exit 0 with something to read (BR-2087, BR-2090).
 */
export const BRIEF_COMMAND =
  "canon brief || echo 'canon brief failed (see above), or canon is not on PATH. This project keeps its rules, decisions and work in canon/, and every change lands through canon work land: do not edit the main branch directly. Fix the error or install canon (ask the user if needed), then run canon brief.'";
/** The form canon installed before BR-2087 required the fallback; found once and replaced in place. */
const OLD_BRIEF_COMMAND = "canon brief";
/**
 * reason: a PreToolUse hook that exits 2 blocks the tool call; without canon on PATH, or on any failure, this line
 * must exit 0 with nothing on stdout, so the Bash call runs unchanged (BR-2128).
 */
export const PRE_BASH_COMMAND = "canon hook pre-bash 2>/dev/null || true";
/** Any other command starting with this is an older form of canon's own entry, rewritten in place. */
const PRE_BASH_PREFIX = "canon hook pre-bash";
/** Matches only the line `canon hook pre-bash` puts in front of a subagent's command (BR-2128). */
export const ACTOR_PERMISSION = "Bash(export CANON_ACTOR='agent:*')";
const SETTINGS = join(".claude", "settings.json");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

type Settings = Record<string, unknown>;

function read(root: string): Result<Settings | undefined> {
  const path = join(root, SETTINGS);
  // reason: checked before existsSync, which follows links: a dangling link would look absent and be written through (BR-2087, #10)
  const link = symlinkOnPath(root, path);
  if (link) return err("invalid", `${relative(root, link)} is a symbolic link; canon edits ${SETTINGS} only as a plain file inside the project`);
  if (!existsSync(path)) return ok(undefined);
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    return err("invalid", `${SETTINGS} is not valid JSON (${(e as Error).message}); fix it and run again`);
  }
  if (!isObject(v)) return err("invalid", `${SETTINGS} must be a JSON object`);
  const perms = v["permissions"];
  if (perms !== undefined && (!isObject(perms) || (perms["allow"] !== undefined && !Array.isArray(perms["allow"])))) {
    return err("invalid", `${SETTINGS}: permissions must be an object whose allow is a list; fix it and run again`);
  }
  return ok(v);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type HookState = "present" | "old" | "missing";

const entries = (settings: Settings | undefined, event: string): HookEntry[] => {
  const list = (settings?.["hooks"] as Record<string, unknown> | undefined)?.[event];
  return Array.isArray(list) ? (list as HookEntry[]) : [];
};

const commandsOf = (list: HookEntry[]) => list.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : []).map((h) => h.command?.trim()));

const bashEntries = (settings: Settings | undefined) => entries(settings, "PreToolUse").filter((e) => e.matcher === "Bash");

function briefState(settings: Settings | undefined): HookState {
  const commands = commandsOf(entries(settings, "SessionStart"));
  if (commands.includes(BRIEF_COMMAND)) return "present";
  return commands.includes(OLD_BRIEF_COMMAND) ? "old" : "missing";
}

function preBashState(settings: Settings | undefined): HookState {
  const commands = commandsOf(bashEntries(settings));
  if (commands.includes(PRE_BASH_COMMAND)) return "present";
  return commands.some((c) => c?.startsWith(PRE_BASH_PREFIX)) ? "old" : "missing";
}

const allowList = (settings: Settings | undefined): unknown[] => ((settings?.["permissions"] as Record<string, unknown> | undefined)?.["allow"] as unknown[] | undefined) ?? [];

export interface SettingsState {
  /** The SessionStart `canon brief` entry (BR-2087). */
  readonly brief: HookState;
  /** The PreToolUse `canon hook pre-bash` entry (BR-2128). */
  readonly preBash: HookState;
  /** Whether the allow rule for the export line is there (BR-2128). */
  readonly permission: boolean;
}

function stateOf(settings: Settings | undefined): SettingsState {
  return { brief: briefState(settings), preBash: preBashState(settings), permission: allowList(settings).includes(ACTOR_PERMISSION) };
}

/** Which of canon's settings entries the project has, in the current form, an older one, or not at all. Reads only. */
export function hookStatus(root: string): Result<SettingsState> {
  const s = read(root);
  if (!s.ok) return s;
  return ok(stateOf(s.value));
}

/** Rewrites an older form of canon's command in place, so a project never ends up with two entries. */
const rewrite = (list: HookEntry[], isOld: (c: string) => boolean, command: string): HookEntry[] =>
  list.map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.map((h) => (h.command !== undefined && isOld(h.command.trim()) ? { ...h, command } : h)) } : e));

/**
 * Adds each of canon's entries that is missing, or rewrites an older form in place; everything else in the file
 * is kept as it was. Returns whether the file changed.
 */
export function ensureHook(root: string): Result<boolean> {
  const s = read(root);
  if (!s.ok) return s;
  const state = stateOf(s.value);
  if (state.brief === "present" && state.preBash === "present" && state.permission) return ok(false);
  const settings = { ...(s.value ?? {}) };
  const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };

  let start = entries(s.value, "SessionStart");
  if (state.brief === "old") start = rewrite(start, (c) => c === OLD_BRIEF_COMMAND, BRIEF_COMMAND);
  else if (state.brief === "missing") start = [...start, { hooks: [{ type: "command", command: BRIEF_COMMAND }] }];
  hooks["SessionStart"] = start;

  let pre = entries(s.value, "PreToolUse");
  if (state.preBash === "old") pre = pre.map((e) => (e.matcher === "Bash" ? rewrite([e], (c) => c.startsWith(PRE_BASH_PREFIX), PRE_BASH_COMMAND)[0]! : e));
  else if (state.preBash === "missing") pre = [...pre, { matcher: "Bash", hooks: [{ type: "command", command: PRE_BASH_COMMAND }] }];
  hooks["PreToolUse"] = pre;
  settings["hooks"] = hooks;

  if (!state.permission) {
    const perms = { ...((settings["permissions"] as Record<string, unknown> | undefined) ?? {}) };
    perms["allow"] = [...allowList(s.value), ACTOR_PERMISSION];
    settings["permissions"] = perms;
  }
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
  return ok(true);
}
