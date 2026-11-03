import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * The one hook canon puts into a project (BR-2087, D-10): at session start Claude Code runs `canon brief`,
 * so a new session learns what it is working on and whether canon's project assets are out of date.
 * It is a *merged* asset: canon owns only its own entry in `.claude/settings.json` and never touches
 * anything else in that file. It reports; it never blocks (D-1: no hook checks how an agent works).
 */
export const BRIEF_COMMAND = "canon brief";
const SETTINGS = join(".claude", "settings.json");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function read(root: string): Result<Record<string, unknown> | undefined> {
  const path = join(root, SETTINGS);
  if (!existsSync(path)) return ok(undefined);
  if (lstatSync(path).isSymbolicLink()) return err("invalid", `${SETTINGS} is a symbolic link; canon edits it only as a plain file`);
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return err("invalid", `${SETTINGS} must be a JSON object`);
    return ok(v as Record<string, unknown>);
  } catch (e) {
    return err("invalid", `${SETTINGS} is not valid JSON (${(e as Error).message}); fix it and run again`);
  }
}

function hasBrief(settings: Record<string, unknown> | undefined): boolean {
  const start = (settings?.["hooks"] as Record<string, unknown> | undefined)?.["SessionStart"];
  return Array.isArray(start) && (start as HookEntry[]).some((e) => e.hooks?.some((h) => h.command?.trim() === BRIEF_COMMAND));
}

/** Whether the project's settings already run `canon brief` at session start. */
export function hookStatus(root: string): Result<"present" | "missing"> {
  const s = read(root);
  if (!s.ok) return s;
  return ok(hasBrief(s.value) ? "present" : "missing");
}

/** Adds the SessionStart entry when it is missing; everything else in the file is kept as it was. */
export function ensureHook(root: string): Result<boolean> {
  const s = read(root);
  if (!s.ok) return s;
  if (hasBrief(s.value)) return ok(false);
  const settings = { ...(s.value ?? {}) };
  const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
  const start = Array.isArray(hooks["SessionStart"]) ? [...(hooks["SessionStart"] as HookEntry[])] : [];
  start.push({ hooks: [{ type: "command", command: BRIEF_COMMAND }] });
  hooks["SessionStart"] = start;
  settings["hooks"] = hooks;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
  return ok(true);
}
