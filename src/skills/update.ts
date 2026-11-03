import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "../app/workspace.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { git } from "../repo/git.ts";
import { land, start, type Say } from "../work/work.ts";
import { ensureHook, hookStatus } from "./hook.ts";
import { installSkills, skillsStatus, type InstallReport } from "./install.ts";

/**
 * Everything canon puts into a project, and how up to date it is (D-10). Discovery is automatic and live:
 * every call recomputes it from the files (no cache that nobody refreshes). Updating is never automatic:
 * the agent tells the user, and `canon update` runs only when someone asks for it.
 *
 *   skills   managed files under .claude/skills/canon-*, protected by a hash manifest (BR-2081)
 *   hook     merged: one SessionStart entry running `canon brief` in .claude/settings.json (BR-2087)
 *   canon/config.yaml, canon/product.md   written once by `canon init`, never touched again
 */
export interface AssetsStatus {
  readonly version: string;
  readonly current: boolean;
  /** One line per out-of-date item, e.g. "skill canon-test/SKILL.md", "hook: canon brief at session start". */
  readonly outdated: readonly string[];
  /** Skill files edited in this project; an update refuses them without --force. */
  readonly edited: readonly string[];
}

export function assetsStatus(root: string, source: string): Result<AssetsStatus> {
  const s = skillsStatus(root, source);
  if (!s.ok) return s;
  const h = hookStatus(root);
  if (!h.ok) return h;
  const outdated = [...s.value.outdated.map((f) => `skill ${f}`), ...(h.value === "missing" ? ["hook: canon brief at session start (.claude/settings.json)"] : [])];
  return ok({ version: s.value.version, current: outdated.length === 0, outdated, edited: s.value.edited });
}

/** The one-line notice `canon brief` and `canon work start` print when something is out of date (BR-2085). */
export function updateNotice(st: AssetsStatus): string | undefined {
  if (st.current) return undefined;
  return `canon's project files are out of date (${st.outdated.length} item(s), version ${st.version}): tell the user; when they want it, run \`canon update\` (details: \`canon update --check\`).`;
}

/** Installs every asset into `root` (the current tree). Used by `canon init` and by `canon update` in its worktree. */
export function installAssets(root: string, source: string, force: boolean): Result<InstallReport & { hook: boolean }> {
  const skills = installSkills(root, source, force);
  if (!skills.ok) return skills;
  const hook = ensureHook(root);
  if (!hook.ok) return hook;
  return ok({ ...skills.value, hook: hook.value });
}

export type UpdateOutcome =
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "landed"; readonly version: string; readonly change: string; readonly sha: string }
  | { readonly kind: "refused"; readonly change: string; readonly message: string };

/**
 * `canon update` (BR-2086): the update is its own change, landed through the normal path (queue, floor,
 * canon check, review), so the project's main only ever gets it the way it gets any other work.
 */
export async function updateProject(ws: Workspace, source: string, force: boolean, timeoutMs: number, say: Say): Promise<Result<UpdateOutcome>> {
  const st = assetsStatus(ws.root, source);
  if (!st.ok) return st;
  if (st.value.current) return ok({ kind: "current", version: st.value.version });
  if (st.value.edited.length > 0 && !force) {
    return err("conflict", `these canon skill files were edited in this project and would be overwritten:\n${st.value.edited.map((e) => `  .claude/skills/${e}`).join("\n")}\nMove the edits into canon itself, or run \`canon update --force\` to discard them.`);
  }
  const started = start(ws, { title: `更新 canon 装进项目的文件到版本 ${st.value.version}` }, say);
  if (!started.ok) return started;
  const wt = started.value.worktree;
  const installed = installAssets(wt, source, force);
  if (!installed.ok) return installed;

  const changeDir = join(wt, "canon", "changes");
  const file = readdirSync(changeDir).find((f) => f === `${started.value.change}.md` || f.startsWith(`${started.value.change}-`))!;
  const text = readFileSync(join(changeDir, file), "utf8");
  const head = text.slice(0, text.indexOf("---\n", 4) + 4);
  writeFileSync(
    join(changeDir, file),
    `${head}\n## 为什么\n\n项目里 canon 装的文件（skill、会话开始时的 hook）落后于当前的 canon，按负责人的要求更新。\n\n## 要改什么\n\n${st.value.outdated.map((o) => `- ${o}`).join("\n")}\n\n## 任务\n\n- [x] 由 \`canon update\` 安装并合入\n`,
  );
  for (const args of [["add", "-A", ".claude", "canon/changes"], ["commit", "-q", "-m", `Update canon project files to ${st.value.version} (${started.value.change})`]]) {
    const r = git(wt, ...args);
    if (!r.ok) return r;
  }
  const lw = openWorkspace(wt);
  if (!lw.ok) return lw;
  const out = await land(lw.value, { finish: true, timeoutMs }, say);
  if (out.kind === "landed") return ok({ kind: "landed", version: st.value.version, change: started.value.change, sha: out.sha });
  const findings = out.kind === "refused" && out.findings ? `\n${out.findings.map((x) => `  ${x.rule} ${x.path}: ${x.message}`).join("\n")}` : "";
  const message = out.kind === "timeout" ? `still ${out.ahead} landing(s) ahead; run \`canon work land --finish\` in ${wt}` : `${out.reason}: ${out.message}${findings}`;
  return ok({ kind: "refused", change: started.value.change, message });
}
