import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { symlinkOnPath } from "./install.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * The hooks canon puts into a project: at session start Claude Code runs `canon brief` (BR-2087, D-10), so a new
 * session learns what it is working on and whether canon's project assets are out of date; before each Bash call it
 * runs `canon snapshot take` (BR-2185, D-30), so uncommitted work can always be recovered, and `canon work check-as` (BR-2343, D-62).
 * It is a *merged* asset: canon owns only its own entry in `.claude/settings.json` and never touches
 * anything else in that file. It reports and records; the one thing it refuses is a canon claim command whose `--as` names the wrong agent (BR-2340, D-62), never how an agent works (D-1). The entries
 * canon withdrew (C-91's PreToolUse hook and allow rule, D-18) are removed by the same write.
 */
/**
 * `|| echo` keeps the session informed when brief fails or canon is not on PATH: a failing hook's stdout is not
 * shown to the model, and the echo makes the line exit 0 with something to read (BR-2087, BR-2090).
 */
export const BRIEF_COMMAND =
  "canon brief || echo 'canon brief failed (see above), or canon is not on PATH. This project keeps its rules, decisions and work in canon/, and every change lands through canon work land: do not edit the main branch directly. Fix the error or install canon (ask the user if needed), then run canon brief.'";
/**
 * Before each Bash call, a snapshot of the worktree's uncommitted work (BR-2182, D-30). It never blocks: when canon
 * fails or is not on PATH, the echo tells the user in a systemMessage and the call goes ahead (BR-2185).
 */
export const SNAPSHOT_COMMAND =
  `canon snapshot take --hook || echo '{"systemMessage":"canon snapshot take failed or canon is not on PATH: uncommitted work was not snapshotted before this Bash call"}'`;
/**
 * Before each Bash call, the check that a canon claim command carries the right `--as` (BR-2340, D-62). It refuses only
 * that: a call it cannot check goes ahead, and when canon fails or is not on PATH the echo tells the user in a systemMessage.
 */
export const CHECK_AS_COMMAND =
  `canon work check-as --hook || echo '{"systemMessage":"canon work check-as failed or canon is not on PATH: --as was not checked for this Bash call"}'`;
/**
 * After each answer to Claude Code's question tool, a record of the questions and the human's answers (BR-2274, D-45).
 * It only records: when canon fails or is not on PATH, the echo tells the user in a systemMessage and nothing is blocked.
 */
export const RECORD_COMMAND =
  `canon human record || echo '{"systemMessage":"canon human record failed or canon is not on PATH: this answer was not recorded for canon"}'`;
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

export type Settings = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const sessionStart = (settings: Settings | undefined): HookEntry[] => {
  const start = (settings?.["hooks"] as Record<string, unknown> | undefined)?.["SessionStart"];
  return Array.isArray(start) ? (start as HookEntry[]) : [];
};

const preToolUse = (settings: Settings | undefined): HookEntry[] => {
  const pre = (settings?.["hooks"] as Record<string, unknown> | undefined)?.["PreToolUse"];
  return Array.isArray(pre) ? (pre as HookEntry[]) : [];
};

const postToolUse = (settings: Settings | undefined): HookEntry[] => {
  const post = (settings?.["hooks"] as Record<string, unknown> | undefined)?.["PostToolUse"];
  return Array.isArray(post) ? (post as HookEntry[]) : [];
};

/** Whether the AskUserQuestion PostToolUse entry with canon's record command is there (BR-2274). */
const hasRecord = (settings: Settings | undefined) =>
  postToolUse(settings).some((e) => isObject(e) && e.matcher === "AskUserQuestion" && Array.isArray(e.hooks) && e.hooks.some((h) => h.command?.trim() === RECORD_COMMAND));

/** Whether the Bash PreToolUse entry with canon's snapshot command is there (BR-2185). */
const hasSnapshot = (settings: Settings | undefined) =>
  preToolUse(settings).some((e) => isObject(e) && e.matcher === "Bash" && Array.isArray(e.hooks) && e.hooks.some((h) => h.command?.trim() === SNAPSHOT_COMMAND));

/** Whether the Bash PreToolUse entry with canon's --as check is there (BR-2343). */
const hasCheckAs = (settings: Settings | undefined) =>
  preToolUse(settings).some((e) => isObject(e) && e.matcher === "Bash" && Array.isArray(e.hooks) && e.hooks.some((h) => h.command?.trim() === CHECK_AS_COMMAND));

function briefState(settings: Settings | undefined): HookState {
  const commands = sessionStart(settings).flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : []).map((h) => h.command?.trim()));
  if (commands.includes(BRIEF_COMMAND)) return "present";
  return commands.includes(OLD_BRIEF_COMMAND) ? "old" : "missing";
}

/**
 * Entries canon installed for a few hours (C-91) and withdrew with D-18: a PreToolUse hook that exported a per-subagent
 * actor, and the allow rule for that export line (issue #26). They are canon's own, so install and update remove them;
 * anything else in the file stays as it was (BR-2087).
 */
const RETIRED_HOOK_PREFIX = "canon hook pre-bash";
const RETIRED_PERMISSION = "Bash(export CANON_ACTOR='agent:*')";
export type Retired = "pre-bash hook" | "actor permission";

const isRetiredHook = (h: unknown) => isObject(h) && typeof h["command"] === "string" && h["command"].trim().startsWith(RETIRED_HOOK_PREFIX);
const holdsRetired = (e: unknown) => isObject(e) && Array.isArray(e["hooks"]) && e["hooks"].some(isRetiredHook);

function retiredIn(settings: Settings | undefined): Retired[] {
  const found: Retired[] = [];
  const pre = isObject(settings?.["hooks"]) ? (settings["hooks"] as Settings)["PreToolUse"] : undefined;
  if (Array.isArray(pre) && pre.some(holdsRetired)) found.push("pre-bash hook");
  const perms = settings?.["permissions"];
  if (isObject(perms) && Array.isArray(perms["allow"]) && perms["allow"].includes(RETIRED_PERMISSION)) found.push("actor permission");
  return found;
}

/** The settings without the retired entries; a list or object left empty only because of that removal goes too. */
function withoutRetired(settings: Settings): Settings {
  const out = { ...settings };
  const hooks = out["hooks"];
  // reason: only a list that held a withdrawn hook is rebuilt, so one that was already empty stays (BR-2130, #50)
  if (isObject(hooks) && Array.isArray(hooks["PreToolUse"]) && (hooks["PreToolUse"] as unknown[]).some(holdsRetired)) {
    const pre = (hooks["PreToolUse"] as unknown[]).flatMap((e) => {
      if (!holdsRetired(e)) return [e];
      const entry = e as Settings;
      const kept = (entry["hooks"] as unknown[]).filter((h) => !isRetiredHook(h));
      return kept.length > 0 ? [{ ...entry, hooks: kept }] : [];
    });
    const next: Settings = { ...hooks, PreToolUse: pre };
    if (pre.length === 0) delete next["PreToolUse"];
    out["hooks"] = next;
  }
  const perms = out["permissions"];
  if (isObject(perms) && Array.isArray(perms["allow"]) && perms["allow"].includes(RETIRED_PERMISSION)) {
    const allow = (perms["allow"] as unknown[]).filter((a) => a !== RETIRED_PERMISSION);
    const next: Settings = { ...perms, allow };
    if (allow.length === 0) delete next["allow"];
    if (Object.keys(next).length === 0) delete out["permissions"];
    else out["permissions"] = next;
  }
  return out;
}

/**
 * Claude Code builds a subagent's worktree from origin's default branch unless `worktree.baseRef` is "head"; origin can be
 * far behind local main (C-60), so canon owns that one key and sets it (BR-2264). Everything else under `worktree` stays.
 */
type BaseRef = "head" | "other" | "invalid";

function baseRefState(settings: Settings | undefined): BaseRef {
  const w = settings?.["worktree"];
  if (w === undefined) return "other";
  if (!isObject(w)) return "invalid";
  return w["baseRef"] === "head" ? "head" : "other";
}

const NOT_OBJECT = err("invalid", `\`worktree\` in ${SETTINGS} must be a JSON object; fix it and run again`);

export interface SettingsState {
  /** The SessionStart `canon brief` entry (BR-2087). */
  readonly brief: HookState;
  /** Whether the snapshot hook before each Bash call is installed (BR-2185). */
  readonly snapshot: boolean;
  /** Whether the --as check hook before each Bash call is installed (BR-2343). */
  readonly checkAs: boolean;
  /** Withdrawn canon entries still in the file; each is out of date until removed (BR-2087, D-18). */
  readonly retired: readonly Retired[];
  /** Whether `worktree.baseRef` is "head" (BR-2264). */
  readonly baseRef: boolean;
  /** Whether the record hook after each answer to the question tool is installed (BR-2274). */
  readonly record: boolean;
}

/** Which of canon's entries the project's settings have: `canon brief` in the current form, an older one or none, and any withdrawn ones. Reads only. */
export function hookStatus(root: string): Result<SettingsState> {
  const s = read(root);
  if (!s.ok) return s;
  const base = baseRefState(s.value);
  if (base === "invalid") return NOT_OBJECT;
  return ok({ brief: briefState(s.value), snapshot: hasSnapshot(s.value), checkAs: hasCheckAs(s.value), retired: retiredIn(s.value), baseRef: base === "head", record: hasRecord(s.value) });
}

/**
 * The settings with the SessionStart entry and the Bash snapshot entry (BR-2185) added when missing, `worktree.baseRef` set to "head" (BR-2264), or the old form's command rewritten in place, so a
 * project never ends up with two, and canon's withdrawn entries removed; everything else is kept as it was. Reads only:
 * undefined when nothing needs writing, an error (exit 2) for a file canon will not edit (BR-2087).
 */
export function planHook(root: string): Result<Settings | undefined> {
  const s = read(root);
  if (!s.ok) return s;
  const state = briefState(s.value);
  const retired = retiredIn(s.value);
  const snapshot = hasSnapshot(s.value);
  const checkAs = hasCheckAs(s.value);
  const base = baseRefState(s.value);
  if (base === "invalid") return NOT_OBJECT;
  const record = hasRecord(s.value);
  if (state === "present" && snapshot && checkAs && record && retired.length === 0 && base === "head") return ok(undefined);
  const settings = retired.length > 0 ? withoutRetired(s.value ?? {}) : { ...(s.value ?? {}) };
  if (state !== "present") {
    const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
    let start = sessionStart(settings);
    if (state === "old") {
      start = start.map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.map((h) => (h.command?.trim() === OLD_BRIEF_COMMAND ? { ...h, command: BRIEF_COMMAND } : h)) } : e));
    } else start = [...start, { hooks: [{ type: "command", command: BRIEF_COMMAND }] }];
    hooks["SessionStart"] = start;
    settings["hooks"] = hooks;
  }
  if (!snapshot) {
    const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
    hooks["PreToolUse"] = [...preToolUse(settings), { matcher: "Bash", hooks: [{ type: "command", command: SNAPSHOT_COMMAND }] }];
    settings["hooks"] = hooks;
  }
  if (!checkAs) {
    const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
    hooks["PreToolUse"] = [...preToolUse(settings), { matcher: "Bash", hooks: [{ type: "command", command: CHECK_AS_COMMAND }] }];
    settings["hooks"] = hooks;
  }
  if (!record) {
    const hooks = { ...((settings["hooks"] as Record<string, unknown> | undefined) ?? {}) };
    hooks["PostToolUse"] = [...postToolUse(settings), { matcher: "AskUserQuestion", hooks: [{ type: "command", command: RECORD_COMMAND }] }];
    settings["hooks"] = hooks;
  }
  if (base !== "head") settings["worktree"] = { ...((settings["worktree"] as Settings | undefined) ?? {}), baseRef: "head" };
  return ok(settings);
}

/** Whether a hook command is one canon writes or once wrote into settings.json. */
const isCanonCommand = (c: unknown) => {
  if (typeof c !== "string") return false;
  const t = c.trim();
  return t === BRIEF_COMMAND || t === OLD_BRIEF_COMMAND || t === SNAPSHOT_COMMAND || t === CHECK_AS_COMMAND || t === RECORD_COMMAND || t.startsWith(RETIRED_HOOK_PREFIX);
};

/** `list` without canon's hooks; an entry left with no hooks goes. Undefined when nothing of canon's was in it. */
function withoutCanonEntries(list: unknown[]): unknown[] | undefined {
  let changed = false;
  const out = list.flatMap((e) => {
    if (!isObject(e) || !Array.isArray(e["hooks"]) || !e["hooks"].some((h) => isObject(h) && isCanonCommand(h["command"]))) return [e];
    changed = true;
    const kept = (e["hooks"] as unknown[]).filter((h) => !(isObject(h) && isCanonCommand(h["command"])));
    return kept.length > 0 ? [{ ...e, hooks: kept }] : [];
  });
  return changed ? out : undefined;
}

/**
 * The settings with every entry canon wrote removed, for `canon uninstall` (BR-2278): its hooks (current, older and
 * withdrawn forms) and its withdrawn allow rule. A list or object left empty only by that removal goes too; `worktree.baseRef`
 * stays, since canon never recorded what was there before (D-46). Reads only: undefined when nothing needs writing,
 * `null` when the file would be left as `{}` and is to be deleted.
 */
export function planUnhook(root: string): Result<Settings | null | undefined> {
  const s = read(root);
  if (!s.ok) return s;
  if (s.value === undefined) return ok(undefined);
  let changed = false;
  const out: Settings = { ...s.value };
  if (isObject(out["hooks"])) {
    const hooks: Settings = { ...out["hooks"] };
    for (const event of Object.keys(hooks)) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      const next = withoutCanonEntries(list);
      if (next === undefined) continue;
      changed = true;
      if (next.length > 0) hooks[event] = next;
      else delete hooks[event];
    }
    if (changed) {
      if (Object.keys(hooks).length > 0) out["hooks"] = hooks;
      else delete out["hooks"];
    }
  }
  // reason: the withdrawn allow rule is canon's too; withoutRetired drops `permissions` when that removal empties it (BR-2130)
  const final = retiredIn(out).includes("actor permission") ? withoutRetired(out) : out;
  if (!changed && final === out) return ok(undefined);
  return ok(Object.keys(final).length === 0 ? null : final);
}

/** Writes what planUnhook computed: the new settings, or deletes the file for `null`; true when it changed anything. */
export function writeUnhook(root: string, settings: Settings | null | undefined): boolean {
  if (settings === undefined) return false;
  if (settings === null) rmSync(join(root, SETTINGS));
  else writeFileSync(join(root, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/** Writes what planHook computed; true when it wrote anything. */
export function writeHook(root: string, settings: Settings | undefined): boolean {
  if (settings === undefined) return false;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
