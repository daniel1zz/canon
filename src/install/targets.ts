import { CODEX_HOOKS } from "./codex.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntime, SKILL_DIRS } from "../kernel/agent.ts";
import { git } from "../kernel/git.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { MANIFEST } from "./install.ts";
import { BRIEF_COMMAND } from "./hook.ts";

export const AGENT_ARG = { agent: { type: "string" as const, description: "Project integrations: claude, codex, or all; existing targets are retained" } };
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
const contains = (path: string, marker: string) => {
  try { return !lstatSync(path).isSymbolicLink() && readFileSync(path, "utf8").includes(marker); } catch { return false; }
};

/** Only Canon's receipts/entries select a target; a user's existing host directory does not (D-101). */
export function installedTargets(root: string): AgentRuntime[] {
  const out: AgentRuntime[] = [];
  if (present(join(root, SKILL_DIRS.claude, MANIFEST)) || contains(join(root, ".claude/settings.json"), BRIEF_COMMAND)) out.push("claude");
  if (present(join(root, SKILL_DIRS.codex, MANIFEST)) || CODEX_HOOKS.some((hook) => contains(join(root, ".codex/hooks.json"), JSON.stringify(hook.command))) || contains(join(root, "AGENTS.md"), "<!-- canon:begin -->") || contains(join(root, "AGENTS.override.md"), "<!-- canon:begin -->")) out.push("codex");
  return out;
}

export function selectedTargets(root: string, requested?: string): Result<AgentRuntime[]> {
  if (requested !== undefined && !["claude", "codex", "all"].includes(requested)) return err("invalid", "--agent must be claude, codex, or all");
  const installed = installedTargets(root);
  const added: AgentRuntime[] = requested === "all" ? ["claude", "codex"] : requested === undefined ? [] : [requested as AgentRuntime];
  const targets = [...new Set([...installed, ...added])];
  return ok(targets.length ? targets : ["claude"]);
}

/** Includes deleted tracked assets as well as new assets, without staging unrelated project files. */
export function projectAssetPaths(root: string): string[] {
  return [".claude", ".agents", ".codex", "AGENTS.md", "AGENTS.override.md"].filter((p) => {
    if (existsSync(join(root, p))) return true;
    const tracked = git(root, "ls-files", "--", p);
    return tracked.ok && tracked.value !== "";
  });
}
