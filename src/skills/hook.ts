import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { symlinkOnPath } from "./install.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * The one hook canon puts into a project (BR-2087, D-10): at session start Claude Code runs `canon brief`,
 * so a new session learns what it is working on and whether canon's project assets are out of date.
 * It is a *merged* asset: canon owns only its own entry in `.claude/settings.json` and never touches
 * anything else in that file. It reports; it never blocks (D-1: no hook checks how an agent works).
 */
/**
 * `|| echo` keeps the session informed when brief fails or canon is not on PATH: a failing hook's stdout is not
 * shown to the model, and the echo makes the line exit 0 with something to read (BR-2087, BR-2090).
 */
export const BRIEF_COMMAND =
  "canon brief || echo 'canon brief failed (see above), or canon is not on PATH. This project keeps its rules, decisions and work in canon/, and every change lands through canon work land: do not edit the main branch directly. Fix the error or install canon (ask the user if needed), then run canon brief.'";
/** The form canon installed before BR-2087 required the fallback; found once and replaced in place. */
const OLD_BRIEF_COMMAND = "canon brief";
const SETTINGS = join(".claude", "settings.json");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function read(root: string): Result<Record<string, unknown> | undefined> {
  const path = join(root, SETTINGS);
  // reason: checked before existsSync, which follows links: a dangling link would look absent and be written through (BR-2087, #10)
  const link = symlinkOnPath(root, path);
  if (link) return err("invalid", `${relative(root, link)} is a symbolic link; canon edits ${SETTINGS} only as a plain file inside the project`);
  if (!existsSync(path)) return ok(undefined);
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return err("invalid", `${SETTINGS} must be a JSON object`);
    return ok(v as Record<string, unknown>);
  } catch (e) {
    return err("invalid", `${SETTINGS} is not valid JSON (${(e as Error).message}); fix it and run again`);
  }
}

type HookState = "present" | "old" | "missing";

const sessionStart = (settings: Record<string, unknown> | undefined): HookEntry[] => {
  const start = (settings?.["hooks"] as Record<string, unknown> | undefined)?.["SessionStart"];
  return Array.isArray(start) ? (start as HookEntry[]) : [];
};

function stateOf(settings: Record<string, unknown> | undefined): HookState {
  const commands = sessionStart(settings).flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : []).map((h) => h.command?.trim()));
  if (commands.includes(BRIEF_COMMAND)) return "present";
  return commands.includes(OLD_BRIEF_COMMAND) ? "old" : "missing";
}

/** Whether the project's settings run `canon brief` at session start, in the current form, an older one, or not at all. */
export function hookStatus(root: string): Result<HookState> {
  const s = read(root);
  if (!s.ok) return s;
  return ok(stateOf(s.value));
}

/**
 * Adds the SessionStart entry when it is missing, or rewrites the old form's command in place, so a project
 * never ends up with two; everything else in the file is kept as it was.
 */
export function ensureHook(root: string): Result<boolean> {
  const s = read(root);
  if (!s.ok) return s;
  const state = stateOf(s.value);
  if (state === "present") return ok(false);
  const settings = { ...(s.value ?? {}) };
  const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
  let start = sessionStart(s.value);
  if (state === "old") {
    start = start.map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.map((h) => (h.command?.trim() === OLD_BRIEF_COMMAND ? { ...h, command: BRIEF_COMMAND } : h)) } : e));
  } else start = [...start, { hooks: [{ type: "command", command: BRIEF_COMMAND }] }];
  hooks["SessionStart"] = start;
  settings["hooks"] = hooks;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
  return ok(true);
}
