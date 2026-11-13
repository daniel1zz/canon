import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "../work/workspace.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { git } from "../kernel/git.ts";
import { ensureExcluded, excludeMissing } from "../kernel/exclude.ts";
import { land } from "../work/land/land.ts";
import { startChore } from "../work/session/session.ts";
import { type Say } from "../work/workspace.ts";
import { hookStatus, planHook, writeHook, type Settings } from "./hook.ts";
import { ensureGuard, foreignGuard, guardStatus } from "./githook.ts";
import { readConfig } from "../invocation/config.ts";
import { ARCHITECTURE_FILE } from "../knowledge/check/architecture.ts";
import { applySkills, editedSkills, planSkills, skillsStatus, type InstallReport, type SkillsPlan } from "./install.ts";

/**
 * Everything canon puts into a project, and how up to date it is (D-10). Discovery is automatic and live:
 * every call recomputes it from the files (no cache that nobody refreshes). Updating is never automatic:
 * the agent tells the user, and `canon update` runs only when someone asks for it.
 *
 *   skills   managed files under .claude/skills/canon-*, protected by a hash manifest (BR-2081)
 *   hook     merged: one SessionStart entry running `canon brief || echo ...` in .claude/settings.json (BR-2087)
 *   guard    the git `reference-transaction` hook in the hooks directory (BR-2123); untracked, so installed in place, never landed
 *   canon/config.yaml, canon/product.md   written once by `canon init`, never touched again
 */
export interface AssetsStatus {
  readonly version: string;
  readonly current: boolean;
  /** One line per out-of-date item, e.g. "skill canon-test/SKILL.md", "hook: canon brief at session start". */
  readonly outdated: readonly string[];
  /** Skill files edited in this project; an update refuses them without --force. */
  readonly edited: readonly string[];
  /** Only things outside the tree are out of date (the git guard, the info/exclude line): an update writes them in place, without a change. */
  readonly localOnly: boolean;
  readonly guard: boolean;
  readonly exclude: boolean;
  /** The project has no canon/architecture.md (D-65); an update writes the template in a change. */
  readonly architecture: boolean;
  /** canon/config.yaml has no links_since while main has a commit; an update writes main's commit in a change (BR-2452). */
  readonly linksSince: boolean;
}

/** What `canon init` and `canon update` write into canon/architecture.md: the headings only, so no check of it applies yet (D-65, BR-2032). */
export const ARCHITECTURE_TEMPLATE = "---\ntitle: 架构总览\n---\n# 架构总览\n\n## 上下文\n\n## 容器\n\n## 主要流程\n";

/** Writes the template when the project has no overview; never touches an existing file (BR-2086). True when it wrote it. */
export function ensureArchitecture(root: string): boolean {
  const full = join(root, ARCHITECTURE_FILE);
  if (existsSync(full)) return false;
  writeFileSync(full, ARCHITECTURE_TEMPLATE);
  return true;
}

/** The comment `canon init` and `canon update` put above the links_since they write (BR-2032, BR-2452). */
// reason: canon/ documents and the config canon writes are in Chinese (CLAUDE.md); a project's text names no canon document id (BR-2096)
export const LINKS_SINCE_COMMENT = "# 可疑引用的起点提交：这个提交里规则和决策之间已有的引用都算复核过，之后的变化才跟踪（canon links）";

/** The commit `main` names in `root`, or undefined when that branch has no commit yet (BR-2032, BR-2452). */
export function mainTip(root: string, main: string): string | undefined {
  const r = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${main}^{commit}`);
  return r.ok && r.value !== "" ? r.value : undefined;
}

/** `canon/config.yaml` text with `links_since` set to `sha`: a line that sets it (to null) is replaced, otherwise the key goes at the end under its comment; every other line stays (BR-2452). */
export function withLinksSince(text: string, sha: string): string {
  const line = `links_since: ${JSON.stringify(sha)}`;
  const set = /^links_since:.*$/m;
  if (set.test(text)) return text.replace(set, line);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${LINKS_SINCE_COMMENT}\n${line}\n`;
}

/** The commit an update writes as links_since: main's, when canon/config.yaml has none and main has a commit (BR-2452). */
function missingLinksSince(root: string): Result<string | undefined> {
  const config = readConfig(root);
  if (!config.ok) return config;
  return ok(config.value.linksSince === undefined ? mainTip(root, config.value.main) : undefined);
}

/** Writes main's current commit as links_since into canon/config.yaml of `root` when it has none (BR-2452). True when it wrote it. */
function ensureLinksSince(root: string): Result<boolean> {
  const sha = missingLinksSince(root);
  if (!sha.ok) return sha;
  if (sha.value === undefined) return ok(false);
  const path = join(root, "canon/config.yaml");
  writeFileSync(path, withLinksSince(existsSync(path) ? readFileSync(path, "utf8") : "", sha.value));
  return ok(true);
}

/** The line git's info/exclude needs so Claude Code's subagent worktrees do not dirty the checkout (BR-2305). */
export const WORKTREES_EXCLUDE = "/.claude/worktrees/";

export function assetsStatus(root: string, source: string): Result<AssetsStatus> {
  const s = skillsStatus(root, source);
  if (!s.ok) return s;
  const h = hookStatus(root);
  if (!h.ok) return h;
  const brief = { present: [], missing: ["hook: canon brief at session start (.claude/settings.json)"], old: ["hook: canon brief at session start, older form that says nothing when canon is not on PATH (.claude/settings.json)"] }[h.value.brief];
  const withdrawn = {
    "pre-bash hook": "hook: canon hook pre-bash before each Bash call, withdrawn by canon; install or update removes it (.claude/settings.json)",
    "actor permission": "permission: Bash(export CANON_ACTOR='agent:*'), withdrawn by canon; install or update removes it (.claude/settings.json)",
  };
  const snapshot = h.value.snapshot ? [] : ["hook: canon snapshot take before each Bash call (.claude/settings.json)"];
  const checkAs = h.value.checkAs ? [] : ["hook: canon work check-as before each Bash call (.claude/settings.json)"];
  const baseRef = h.value.baseRef ? [] : ['setting: worktree.baseRef "head", so subagent worktrees start from local HEAD (.claude/settings.json)'];
  const record = h.value.record ? [] : ["hook: canon human record after each answer to the question tool (.claude/settings.json)"];
  const restatement = h.value.restatement ? [] : ["hook: canon restatements --hook after each Write or Edit (.claude/settings.json)"];
  const hook = [...brief, ...snapshot, ...checkAs, ...record, ...restatement, ...h.value.retired.map((r) => withdrawn[r]), ...baseRef];
  const g = guardLine(root);
  if (!g.ok) return g;
  const x = excludeMissing(root, WORKTREES_EXCLUDE);
  if (!x.ok) return x;
  const exclude = x.value ? [`git exclude: ${WORKTREES_EXCLUDE} in the repository's info/exclude, so Claude Code's subagent worktrees do not dirty the checkout`] : [];
  const missingOverview = !existsSync(join(root, ARCHITECTURE_FILE));
  const overview = missingOverview ? [`file ${ARCHITECTURE_FILE}: missing, a template with only its headings`] : [];
  const since = missingLinksSince(root);
  if (!since.ok) return since;
  const links = since.value === undefined ? [] : [`config canon/config.yaml: links_since missing, main's commit ${since.value.slice(0, 9)} as the start of suspect references`];
  const outdated = [...s.value.outdated.map((f) => `skill ${f}`), ...hook, ...overview, ...links, ...g.value.line, ...exclude];
  const local = g.value.line.length > 0 || x.value;
  // reason: the overview and canon/config.yaml are tracked files, so their updates are never local-only (BR-2086, BR-2452)
  return ok({ version: s.value.version, current: outdated.length === 0, outdated, edited: s.value.edited, localOnly: s.value.outdated.length === 0 && hook.length === 0 && !missingOverview && links.length === 0 && local, guard: g.value.line.length > 0, exclude: x.value, architecture: missingOverview, linksSince: links.length > 0 });
}

/** The update-check line for the git guard (BR-2123, BR-2124). */
function guardLine(root: string): Result<{ line: string[] }> {
  const config = readConfig(root);
  if (!config.ok) return config;
  const g = guardStatus(root, config.value.main);
  if (!g.ok) return g;
  const what = `git hook: main moves only through canon work land (${g.value.path})`;
  const line = { current: [], missing: [what], old: [`${what}, older form`], foreign: [`${what}, not installed: that file was not written by canon`] }[g.value.state];
  return ok({ line });
}

/** The one-line notice `canon brief` and `canon work start` print when something is out of date (BR-2085). */
export function updateNotice(st: AssetsStatus): string | undefined {
  if (st.current) return undefined;
  return `canon's project files are out of date (${st.outdated.length} item(s), version ${st.version}): tell the user; when they want it, run \`canon update\` (details: \`canon update --check\`).`;
}

/**
 * Every check an install makes, in the order the rules give, with nothing written yet: the main branch name and someone
 * else's git hook (BR-2123, BR-2124), then the skills (symlinks and the manifest, BR-2083, before edited files, BR-2081),
 * then `.claude/settings.json` (BR-2087). Edited skill files are returned, not refused, so each caller words the refusal.
 */
function preflight(root: string, source: string, force: boolean, mainBranch?: string): Result<{ main: string; skills: SkillsPlan; settings: Settings | undefined }> {
  const config = readConfig(root);
  if (!config.ok) return config;
  const main = mainBranch ?? config.value.main;
  const g = guardStatus(root, main);
  if (!g.ok) return g;
  if (g.value.state === "foreign") return foreignGuard(g.value.path);
  const skills = planSkills(root, source, force);
  if (!skills.ok) return skills;
  const settings = planHook(root);
  if (!settings.ok) return settings;
  return ok({ main, skills: skills.value, settings: settings.value });
}

/**
 * Installs every asset into `root` (the current tree), only after every check passed. Used by `canon init`, `canon install`
 * and by `canon update` in its worktree. `mainBranch` is for `canon init` before it writes canon/config.yaml: the guard
 * then protects the branch init is about to write there, not the default (BR-2032).
 */
export function installAssets(root: string, source: string, force: boolean, mainBranch?: string): Result<InstallReport & { hook: boolean; guard: boolean; exclude: boolean }> {
  const p = preflight(root, source, force, mainBranch);
  if (!p.ok) return p;
  if (p.value.skills.conflicts.length > 0) return editedSkills(p.value.skills.conflicts, "run again with --force");
  const skills = applySkills(p.value.skills);
  const hook = writeHook(root, p.value.settings);
  const guard = ensureGuard(root, p.value.main);
  if (!guard.ok) return guard;
  const exclude = ensureExcluded(root, WORKTREES_EXCLUDE);
  if (!exclude.ok) return exclude;
  return ok({ ...skills, hook, guard: guard.value, exclude: exclude.value });
}

export type UpdateOutcome =
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "local"; readonly version: string; readonly guard: boolean; readonly exclude: boolean }
  | { readonly kind: "landed"; readonly version: string; readonly change: string; readonly sha: string }
  | { readonly kind: "refused" | "timeout"; readonly change: string; readonly message: string };

/**
 * `canon update` (BR-2086): the update is its own change, landed through the normal path (queue, floor,
 * canon check, review), so the project's main only ever gets it the way it gets any other work.
 */
export async function updateProject(ws: Workspace, source: string, force: boolean, timeoutMs: number, say: Say): Promise<Result<UpdateOutcome>> {
  // Someone else's git hook refuses before any other check, a broken settings.json included (BR-2124).
  const g = guardStatus(ws.root, ws.config.main);
  if (!g.ok) return g;
  if (g.value.state === "foreign") return foreignGuard(g.value.path);
  const st = assetsStatus(ws.root, source);
  if (!st.ok) return st;
  if (st.value.current) return ok({ kind: "current", version: st.value.version });
  if (st.value.localOnly) {
    // reason: the git hook and the exclude line live outside the tree, so there is nothing to land; they are written in place (BR-2086, BR-2123, BR-2305)
    if (st.value.guard) {
      const guard = ensureGuard(ws.root, ws.config.main);
      if (!guard.ok) return guard;
    }
    const exclude = ensureExcluded(ws.root, WORKTREES_EXCLUDE);
    if (!exclude.ok) return exclude;
    return ok({ kind: "local", version: st.value.version, guard: st.value.guard, exclude: st.value.exclude });
  }
  // Every refusal an install can make is made here, before a change or worktree exists (BR-2086, BR-2083).
  const p = preflight(ws.root, source, force);
  if (!p.ok) return p;
  if (p.value.skills.conflicts.length > 0) return editedSkills(p.value.skills.conflicts, "run `canon update --force`");
  const started = startChore(ws, { title: `更新 canon 装进项目的文件到版本 ${st.value.version}` }, say);
  if (!started.ok) return started;
  const wt = started.value.worktree;
  const installed = installAssets(wt, source, force);
  if (!installed.ok) return installed;
  const overview = ensureArchitecture(wt);
  // reason: main's commit when the change starts, read in its worktree, is the start of suspect references (BR-2452)
  const since = ensureLinksSince(wt);
  if (!since.ok) return since;

  for (const args of [["add", "-A", ".claude", ...(overview ? [ARCHITECTURE_FILE] : []), ...(since.value ? ["canon/config.yaml"] : [])], ["commit", "-q", "-m", `Update canon project files to ${st.value.version} (${started.value.change})\n\n${st.value.outdated.map((o) => `- ${o}`).join("\n")}`]]) {
    const r = git(wt, ...args);
    if (!r.ok) return r;
  }
  const lw = openWorkspace(wt);
  if (!lw.ok) return lw;
  const out = await land(lw.value, { finish: true, timeoutMs }, say);
  if (out.kind === "landed") return ok({ kind: "landed", version: st.value.version, change: started.value.change, sha: out.sha });
  const findings = out.kind === "refused" && out.findings ? `\n${out.findings.map((x) => `  ${x.rule} ${x.path}: ${x.message}`).join("\n")}` : "";
  const message = out.kind === "timeout" ? `still ${out.ahead} landing(s) ahead; run \`canon chore land\` in ${wt}` : `${out.reason}: ${out.message}${findings}`;
  return ok({ kind: out.kind, change: started.value.change, message });
}
