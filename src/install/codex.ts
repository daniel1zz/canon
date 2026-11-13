import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import { symlinkOnPath } from "./install.ts";
import { BRIEF_COMMAND, CHECK_AS_COMMAND, RECORD_COMMAND, RESTATEMENT_COMMAND, SNAPSHOT_COMMAND, type Settings } from "./hook.ts";

const HOOKS = ".codex/hooks.json";
const BEGIN = "<!-- canon:begin -->";
const END = "<!-- canon:end -->";
export const CODEX_INSTRUCTIONS = `${BEGIN}\nRun \`canon brief\` at the start of each session and follow the workflow it prints.\nUse the applicable canon skills in \`.agents/skills/\`.\n${END}`;
// Codex's documented hook aliases normalize exec_command to Bash; apply_patch carries tool_input.command.
export const CODEX_HOOKS = [
  { event: "SessionStart", command: BRIEF_COMMAND.replace("canon brief", "canon brief --hook --runtime codex") },
  { event: "SubagentStart", command: BRIEF_COMMAND.replace("canon brief", "canon brief --hook --runtime codex") },
  { event: "PreToolUse", matcher: "Bash", command: SNAPSHOT_COMMAND.replace("--hook", "--hook --runtime codex") },
  { event: "PreToolUse", matcher: "Bash", command: CHECK_AS_COMMAND.replace("--hook", "--hook --runtime codex") },
  { event: "PostToolUse", matcher: "request_user_input", command: RECORD_COMMAND.replace("canon human record", "canon human record --runtime codex") },
  { event: "PostToolUse", matcher: "apply_patch|Write|Edit", command: RESTATEMENT_COMMAND.replace("--hook", "--hook --runtime codex") },
] as const;
const object = (v: unknown): v is Settings => v !== null && typeof v === "object" && !Array.isArray(v);

function textAt(root: string, path: string): Result<string | undefined> {
  const full = join(root, path);
  const link = symlinkOnPath(root, full);
  if (link) return err("invalid", `${relative(root, link)} is a symbolic link; canon writes project assets only as plain files`);
  try { return ok(existsSync(full) ? readFileSync(full, "utf8") : undefined); }
  catch (e) { return err("invalid", `cannot read ${path}: ${(e as Error).message}`); }
}

function instructions(root: string, path: string, remove: boolean): Result<string | null | undefined> {
  const read = textAt(root, path);
  if (!read.ok) return read;
  const text = read.value ?? "";
  const begins = [...text.matchAll(/<!-- canon:begin -->/g)];
  const ends = [...text.matchAll(/<!-- canon:end -->/g)];
  if (begins.length !== ends.length || begins.length > 1 || (begins.length === 1 && begins[0]!.index! > ends[0]!.index!)) return err("invalid", `${path} has malformed or repeated canon markers; fix them before installing or removing canon`);
  if (begins.length === 0) return ok(remove ? undefined : `${text}${text ? "\n" : ""}${CODEX_INSTRUCTIONS}\n`);
  let start = begins[0]!.index!;
  let end = ends[0]!.index! + END.length;
  if (!remove) {
    const next = text.slice(0, start) + CODEX_INSTRUCTIONS + text.slice(end);
    return ok(next === text ? undefined : next);
  }
  if (start > 0 && text[start - 1] === "\n") start--;
  if (text[end] === "\n") end++;
  const next = text.slice(0, start) + text.slice(end);
  return ok(next.trim() === "" ? null : next);
}

export interface CodexPlan {
  readonly hooks: Settings | null | undefined;
  readonly instructions: Readonly<Record<string, string | null | undefined>>;
  readonly outdated: readonly string[];
}

/** Plans both merged assets without writing, so multi-target installs can finish every preflight first. */
export function planCodex(root: string, remove = false): Result<CodexPlan> {
  const read = textAt(root, HOOKS);
  if (!read.ok) return read;
  let settings: Settings = {};
  try {
    const parsed: unknown = read.value === undefined ? {} : JSON.parse(read.value);
    if (!object(parsed) || (parsed["hooks"] !== undefined && !object(parsed["hooks"]))) throw new Error("settings and hooks must be JSON objects");
    settings = parsed;
  } catch (e) { return err("invalid", `${HOOKS} is not valid hook settings: ${(e as Error).message}`); }
  const hooks: Settings = { ...((settings["hooks"] as Settings | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries) || entries.some((entry) => !object(entry) || (entry["matcher"] !== undefined && typeof entry["matcher"] !== "string") || !Array.isArray(entry["hooks"]) || entry["hooks"].some((h: unknown) => !object(h)))) return err("invalid", `${HOOKS}: hooks.${event} must be a list of matcher groups with hooks arrays`);
  }
  const outdated: string[] = [];
  let changed = false;
  for (const definition of CODEX_HOOKS) {
    let entries = (hooks[definition.event] ?? []) as Settings[];
    if (definition.event.endsWith("Start")) {
      let migrated = false;
      entries = entries.flatMap((entry) => {
        const handlers = entry["hooks"] as Settings[];
        if (!handlers.some((handler) => handler["command"] === BRIEF_COMMAND)) return [entry];
        migrated = true;
        const next = handlers.flatMap((handler) => handler["command"] !== BRIEF_COMMAND ? [handler] : remove ? [] : [{ ...handler, command: definition.command, additionalContextLimit: 8000 }]);
        return next.length ? [{ ...entry, hooks: next }] : [];
      });
      if (migrated) {
        changed = true;
        hooks[definition.event] = entries;
        if (!remove) outdated.push(`hook: ${definition.event} startup session registration outdated (${HOOKS})`);
      }
    }
    const matcher = "matcher" in definition ? definition.matcher : undefined;
    if (remove) {
      const kept = entries.flatMap((entry) => {
        const handlers = entry["hooks"] as Settings[];
        const next = handlers.filter((h) => h["command"] !== definition.command);
        if (next.length === handlers.length) return [entry];
        changed = true;
        return next.length ? [{ ...entry, hooks: next }] : [];
      });
      if (kept.length) hooks[definition.event] = kept;
      else delete hooks[definition.event];
    } else if (!entries.some((entry) => entry["matcher"] === matcher && (entry["hooks"] as Settings[]).some((h) => h["command"] === definition.command))) {
      hooks[definition.event] = [...entries, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: definition.command, ...(definition.event.endsWith("Start") ? { additionalContextLimit: 8000 } : {}) }] }];
      changed = true;
      outdated.push(`hook: ${definition.event}${matcher ? ` ${matcher}` : ""} ${definition.command.split(" ||")[0]} (${HOOKS})`);
    }
  }
  const next = { ...settings };
  if (Object.keys(hooks).length) next["hooks"] = hooks;
  else delete next["hooks"];
  const override = textAt(root, "AGENTS.override.md");
  if (!override.ok) return override;
  const active = override.value?.trim() ? "AGENTS.override.md" : "AGENTS.md";
  const files: Record<string, string | null | undefined> = {};
  for (const path of ["AGENTS.md", "AGENTS.override.md"]) {
    const agents = instructions(root, path, remove || path !== active);
    if (!agents.ok) return agents;
    files[path] = agents.value;
    if (!remove && agents.value !== undefined) outdated.push(`file ${path}: canon instruction block missing or outdated`);
  }
  return ok({ hooks: changed ? Object.keys(next).length ? next : null : undefined, instructions: files, outdated });
}

export function applyCodex(root: string, plan: CodexPlan): boolean {
  for (const [path, value] of [[HOOKS, plan.hooks === undefined || plan.hooks === null ? plan.hooks : `${JSON.stringify(plan.hooks, null, 2)}\n`], ...Object.entries(plan.instructions)] as const) {
    if (value === undefined) continue;
    const full = join(root, path);
    if (value === null) rmSync(full);
    else {
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, value);
    }
  }
  return plan.hooks !== undefined || Object.values(plan.instructions).some((v) => v !== undefined);
}

export function codexHookStatus(root: string): Result<{ checkAs: boolean; record: boolean }> {
  const plan = planCodex(root);
  if (!plan.ok) return plan;
  return ok({ checkAs: !plan.value.outdated.some((s) => s.includes("canon work check-as")), record: !plan.value.outdated.some((s) => s.includes("canon human record")) });
}
