import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readConfig, type Config } from "../../config/config.ts";
import { GENERATED_DIR } from "../../config/reference/reference.ts";
import { batchState, settleBackgroundHooks } from "../../config/hooks.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git, listWorktreesKeepingState, listWorktreesLocked, toplevel } from "../../kernel/git.ts";
import { CoordDb } from "../../work/db.ts";
import { liveClaims } from "../../work/claims/claims.ts";
import { land } from "../../work/land/land.ts";
import { sync } from "../../work/remote/remote.ts";
import { clean, keepReason, start, worktreesDir } from "../../work/session/session.ts";
import { liveWatcher } from "../../work/watch/watch.ts";
import { currentActor, openWorkspace, type Say, type Workspace } from "../../work/workspace.ts";
import { hooksDir, removeGuard } from "./githook.ts";
import { planUnhook, writeUnhook } from "./hook.ts";
import { applyUnskills, planUnskills } from "./install.ts";

/**
 * `canon uninstall` (D-46). canon/config.yaml on main is canon's switch: while it is there, every clone's git guard is
 * armed. So the removal of what canon put into the tree (skills, its settings entries, the config) lands as one change
 * through the normal path (BR-2278), only once nothing else is in flight (BR-2277); after that, each clone cleans up
 * what canon keeps outside the tree (BR-2280). The project's knowledge under canon/ and the recovery refs stay unless
 * asked for (BR-2281, BR-2282).
 */
export interface UninstallOptions {
  readonly force: boolean;
  readonly purgeRecovery: boolean;
  readonly removeKnowledge: boolean;
  /** Minutes to wait in the landing queue; undefined: land_timeout_minutes of the config being removed. */
  readonly timeoutMs: number | undefined;
}

export type UninstallOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "refused" | "timeout" | "later"; readonly message: string };

const CONFIG = "canon/config.yaml";
const RECOVERY = ["refs/canon/archive", "refs/canon/snapshots"] as const;

const onMain = (root: string, main: string, path: string) => git(root, "cat-file", "-e", `refs/heads/${main}:${path}`).ok;

/** The changes that still hold work (BR-2277): live claims, worktrees that would lose work, unlanded change branches. */
export function inFlight(ws: Workspace): Result<string[]> {
  const out: string[] = [];
  const claims = liveClaims(ws.db);
  for (const c of claims) out.push(`${c.subject}: claimed (${c.holder})`);
  const held = new Set(claims.map((c) => c.holder));
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return wts;
  const dir = worktreesDir(ws) + "/";
  const withWorktree = new Set<string>();
  for (const w of wts.value.filter((w) => w.path.startsWith(dir))) {
    if (w.branch) withWorktree.add(w.branch);
    if (held.has(w.path)) continue;
    const why = keepReason(ws, w, new Set());
    if (why) out.push(`${basename(w.path)}: ${why} (${w.path})`);
  }
  const branches = git(ws.primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/");
  if (!branches.ok) return branches;
  for (const b of branches.value.split("\n").filter(Boolean)) {
    if (withWorktree.has(b)) continue;
    const ahead = git(ws.primary, "rev-list", "--count", `${ws.config.main}..refs/heads/${b}`);
    if (!ahead.ok || ahead.value !== "0") out.push(`${b}: ${ahead.ok ? ahead.value : "?"} commit(s) not on ${ws.config.main}`);
  }
  return ok(out);
}

/** A config read from its text, as readConfig reads the file. */
function parseConfig(text: string): Result<Config> {
  const dir = mkdtempSync(join(tmpdir(), "canon-uninstall-"));
  try {
    mkdirSync(join(dir, "canon"));
    writeFileSync(join(dir, CONFIG), `${text}\n`);
    return readConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Which branch is main: the working tree's config names it while it is there, else canon's guard does (it is written for
 * one branch), else the branch checked out. Judged this way because the working tree can be ahead of main: a pull the
 * guard refused leaves the remote's files checked out while main stays put.
 */
function mainName(root: string): string {
  if (existsSync(join(root, CONFIG))) {
    const c = readConfig(root);
    if (c.ok) return c.value.main;
  }
  const dir = hooksDir(root);
  if (dir.ok && existsSync(join(dir.value, "reference-transaction"))) {
    const m = /\[ "\$ref" = "refs\/heads\/(.+)" \]/.exec(readFileSync(join(dir.value, "reference-transaction"), "utf8"));
    if (m) return m[1]!.replace(/\\(.)/g, "$1");
  }
  const b = git(root, "symbolic-ref", "--short", "-q", "HEAD");
  return b.ok && b.value ? b.value : "main";
}

/**
 * canon's config as main has it (`on`: canon is still on main, BR-2278), else the version right before the commit that
 * deleted it from main (`on: false`, the local cleanup, BR-2280); undefined when main never had one.
 */
function mainConfig(root: string): Result<{ config: Config; on: boolean } | undefined> {
  const main = mainName(root);
  const now = git(root, "show", `refs/heads/${main}:${CONFIG}`);
  if (now.ok) {
    const c = parseConfig(now.value);
    return c.ok ? ok({ config: c.value, on: true }) : c;
  }
  const del = git(root, "log", "-1", "--format=%H", "--diff-filter=D", `refs/heads/${main}`, "--", CONFIG);
  if (!del.ok || del.value === "") return ok(undefined);
  const before = git(root, "show", `${del.value}^:${CONFIG}`);
  if (!before.ok) return before;
  const c = parseConfig(before.value);
  return c.ok ? ok({ config: c.value, on: false }) : c;
}

/** Pushes main to the remote the removed config named; a failure is said, the commit stays (BR-2278, BR-2282). */
function pushTo(root: string, config: Config, say: Say): void {
  if (!config.remote) return;
  const r = git(root, "push", "--porcelain", "--no-follow-tags", config.remote, `refs/heads/${config.main}:refs/heads/${config.main}`);
  say(r.ok ? `pushed ${config.main} to ${config.remote}` : `could not push ${config.main} to ${config.remote} (${r.error.message}); push it yourself`);
}

export async function uninstall(cwd: string, opts: UninstallOptions, say: Say): Promise<Result<UninstallOutcome>> {
  const top = toplevel(cwd);
  if (!top.ok) return top;
  const root = top.value;
  const before = mainConfig(root);
  if (!before.ok) return before;
  if (before.value?.on) {
    const removed = await removeFromMain(root, before.value.config, opts, say);
    if (!removed.ok || removed.value.kind !== "done") return removed;
    say("canon/config.yaml is off main; cleaning up what canon keeps outside the tree");
  }
  return cleanUp(root, before.value?.config, opts, say);
}

/** Lands the removal of canon's tracked files and canon/config.yaml as one change (BR-2277, BR-2278, BR-2279). */
async function removeFromMain(root: string, config: Config, opts: UninstallOptions, say: Say): Promise<Result<UninstallOutcome>> {
  const opened = openWorkspace(root);
  if (!opened.ok) return opened;
  // reason: main's config, not the working tree's, which a refused pull can leave ahead of main
  const ws: Workspace = { ...opened.value, config };
  const busy = inFlight(ws);
  if (!busy.ok) return busy;
  if (busy.value.length > 0) {
    return err("conflict", `work is still in flight; land it, or archive it with \`canon work drop <C-n>\`, then run canon uninstall again:\n${busy.value.map((l) => `  ${l}`).join("\n")}`);
  }
  const skills = planUnskills(root, opts.force);
  if (!skills.ok) return skills;
  if (skills.value.edited.length > 0 && !opts.force) {
    return err("conflict", `these canon skill files were edited in this project and would be deleted:\n${skills.value.edited.map((c) => `  .claude/skills/${c}`).join("\n")}\nKeep a copy elsewhere, or run canon uninstall --force to delete them too.`);
  }
  const settings = planUnhook(root);
  if (!settings.ok) return settings;
  if (ws.config.remote) {
    const synced = sync(ws, say);
    if (!synced.ok) return synced;
    // reason: the remote may already hold an uninstall landed from another clone; then only the local cleanup is left (BR-2280)
    if (!onMain(root, ws.config.main, CONFIG)) return ok({ kind: "done" });
  }

  const started = start(ws, { title: "卸载 canon" }, say);
  if (!started.ok) return started;
  const wt = started.value.worktree;
  // reason: opened before canon/config.yaml is deleted, so the landing runs with the floor and review it had (BR-2278)
  const lw = openWorkspace(wt);
  if (!lw.ok) return lw;
  const wtSkills = planUnskills(wt, opts.force);
  if (!wtSkills.ok) return wtSkills;
  const removed = applyUnskills(wtSkills.value);
  const wtSettings = planUnhook(wt);
  if (!wtSettings.ok) return wtSettings;
  writeUnhook(wt, wtSettings.value);
  rmSync(join(wt, CONFIG));
  const claudeDir = join(wt, ".claude");
  if (existsSync(claudeDir) && readdirSync(claudeDir).length === 0) rmSync(claudeDir, { recursive: true });

  const changeDir = join(wt, "canon", "changes");
  const file = readdirSync(changeDir).find((f) => f === `${started.value.change}.md` || f.startsWith(`${started.value.change}-`))!;
  const text = readFileSync(join(changeDir, file), "utf8");
  const head = text.slice(0, text.indexOf("---\n", 4) + 4);
  const settingsLine = wtSettings.value === undefined ? [] : [wtSettings.value === null ? "- `.claude/settings.json`（只剩 canon 的条目，整个删掉）" : "- `.claude/settings.json` 里 canon 的条目"];
  writeFileSync(
    join(changeDir, file),
    `${head}\n## 为什么\n\n负责人要求把 canon 从这个项目里移除（\`canon uninstall\`）。\n\n## 要改什么\n\n删掉 canon 装进项目的文件和 \`canon/config.yaml\`；\`canon/\` 下其余文档保留。\n\n- ${removed.length} 个 canon skill 文件和清单 \`.claude/skills/.canon-skills.json\`\n${settingsLine.map((l) => `${l}\n`).join("")}- \`canon/config.yaml\`\n\n## 教训\n\n无。\n\n## 任务\n\n- [x] 由 \`canon uninstall\` 删除并合入\n`,
  );
  for (const args of [["add", "-A", "--", ".claude", "canon"], ["commit", "-q", "-m", `Uninstall canon (${started.value.change})`]]) {
    const r = git(wt, ...args);
    if (!r.ok) return r;
  }
  const out = await land(lw.value, { finish: true, timeoutMs: opts.timeoutMs ?? ws.config.landTimeoutMs }, say);
  if (out.kind === "timeout") return ok({ kind: "timeout", message: `still ${out.ahead} landing(s) ahead; run \`canon work land --finish\` in ${wt}, then canon uninstall again` });
  if (out.kind === "refused") {
    const findings = out.findings ? `\n${out.findings.map((x) => `  ${x.rule} ${x.path}: ${x.message}`).join("\n")}` : "";
    return ok({ kind: "refused", message: `the uninstall ${started.value.change} did not land (${out.reason}): ${out.message}${findings}\nFix it in ${wt}, run \`canon work land --finish\` there, then canon uninstall again; nothing outside the tree was removed` });
  }
  say(`uninstall landed as ${started.value.change} (${out.sha.slice(0, 9)})`);
  // reason: the landing's own push reads the remote from main's config, which this commit just removed (BR-2278)
  pushTo(ws.primary, ws.config, say);
  say('kept worktree.baseRef "head" in .claude/settings.json: canon does not know what was there before; remove it yourself if you do not want it');
  return ok({ kind: "done" });
}

/** The repository's git common directory, absolute. */
function commonDir(root: string): Result<string> {
  return git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

/** Everything canon keeps outside the tree in this clone (BR-2280, BR-2281, BR-2283), then --remove-knowledge (BR-2282). */
function cleanUp(root: string, config: Config | undefined, opts: UninstallOptions, say: Say): Result<UninstallOutcome> {
  const common = commonDir(root);
  if (!common.ok) return common;
  const state = join(common.value, "canon");
  const dbPath = join(state, "state.db");
  const actor = currentActor();
  if (!actor.ok) return actor;
  // reason: under the worktree lock while the state directory exists; without it, unlocked, so the lock does not create it again (BR-2280, BR-2223)
  const wts = listWorktreesKeepingState(root);
  if (!wts.ok) return wts;
  const primary = wts.value[0]!.path;
  const main = config?.main ?? "main";

  let db: CoordDb | undefined;
  if (existsSync(dbPath)) {
    const opened = CoordDb.open(dbPath, root);
    if (!opened.ok) return opened;
    db = opened.value;
    // The landing's background commands and the floor watcher still write here; wait for them (BR-2283).
    const batch = settleBackgroundHooks(db, actor.value);
    if (batch && batchState(batch) === "running") return ok({ kind: "later", message: "the last landing's after_land commands are still running; run canon uninstall again once they finish (canon work after-land --wait)" });
    if (liveWatcher(db)) return ok({ kind: "later", message: "canon's background floor watcher is still running; run canon uninstall again once it finishes" });
  }

  let did = false;
  const kept: string[] = [];
  const guard = removeGuard(root);
  if (!guard.ok) return guard;
  if (guard.value === "removed") {
    did = true;
    say("removed canon's git hook (reference-transaction)");
  } else if (guard.value === "foreign") say("left the reference-transaction hook alone: canon did not write it");

  if (config && db) {
    const ws: Workspace = { root, primary, db, config, actor: actor.value };
    const c = clean(ws, say);
    if (!c.ok) return c;
    if (c.value.removed.length > 0) did = true;
    kept.push(...c.value.kept);
    const dir = worktreesDir(ws);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    const branches = git(primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/");
    for (const b of branches.ok ? branches.value.split("\n").filter(Boolean) : []) {
      if (wts.value.some((w) => w.branch === b)) continue;
      const tip = git(primary, "rev-parse", "--verify", `refs/heads/${b}`);
      if (!tip.ok) continue;
      if (!git(primary, "merge-base", "--is-ancestor", tip.value, main).ok) {
        kept.push(`${b}: commits not on ${main}`);
        continue;
      }
      git(primary, "update-ref", "-d", `refs/heads/${b}`, tip.value);
      did = true;
      say(`deleted branch ${b} (on ${main})`);
    }
    // A claim on a worktree outside the worktrees directory is live work too.
    for (const c of liveClaims(db)) if (!kept.some((k) => k.startsWith(`${c.holder}:`))) kept.push(`${c.subject}: claimed (${c.holder})`);
  }
  // reason: a session still working needs its claim, port and handoff rows; the state and refs stay until it is done, so
  // the next run still sees it (BR-2280, #105)
  if (kept.length > 0) {
    db?.db.close();
    return err("conflict", `work is still in this clone; land it, or archive it with \`canon work drop <C-n>\`, then run canon uninstall again (canon's state was left in place):\n${kept.map((k) => `  ${k}`).join("\n")}`);
  }

  const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/canon/");
  const all = refs.ok ? refs.value.split("\n").filter(Boolean) : [];
  const recovery = all.filter((r) => RECOVERY.some((p) => r.startsWith(`${p}/`)));
  const drop = opts.purgeRecovery ? all : all.filter((r) => !recovery.includes(r));
  for (const r of drop) git(root, "update-ref", "-d", r);
  if (drop.length > 0) did = true;
  if (opts.purgeRecovery && recovery.length > 0) say(`deleted ${recovery.length} recovery ref(s) under refs/canon/archive and refs/canon/snapshots`);
  else if (recovery.length > 0) {
    const n = (p: string) => recovery.filter((r) => r.startsWith(`${p}/`)).length;
    say(`kept ${n(RECOVERY[0])} archive(s) under refs/canon/archive and ${n(RECOVERY[1])} snapshot(s) under refs/canon/snapshots; nothing cleans them up any more.`);
    say("  list them: git for-each-ref refs/canon/archive refs/canon/snapshots · get one back: git checkout -b <branch> <ref> · delete them: canon uninstall --purge-recovery");
  }

  if (db) db.db.close();
  if (existsSync(state)) {
    rmSync(state, { recursive: true, force: true });
    did = true;
    say(`removed ${state}`);
  }
  const generated = join(root, GENERATED_DIR);
  if (existsSync(generated)) {
    rmSync(generated, { recursive: true, force: true });
    did = true;
  }
  const exclude = join(common.value, "info", "exclude");
  if (existsSync(exclude)) {
    const lines = readFileSync(exclude, "utf8").split("\n");
    const rest = lines.filter((l) => l.trim() !== `/${GENERATED_DIR}/`);
    if (rest.length !== lines.length) {
      writeFileSync(exclude, rest.join("\n"));
      did = true;
    }
  }

  const knowledge = opts.removeKnowledge ? removeKnowledge(primary, config, say) : ok(false);
  if (!knowledge.ok) return knowledge;
  if (knowledge.value) did = true;

  if (!did) return ok({ kind: "not-installed" });
  return ok({ kind: "done" });
}

/** `--remove-knowledge` (BR-2282): canon/ leaves main in a commit of its own, made in the primary checkout. */
function removeKnowledge(primary: string, config: Config | undefined, say: Say): Result<boolean> {
  const main = config?.main ?? "main";
  if (!git(primary, "cat-file", "-e", `refs/heads/${main}:canon`).ok) return ok(false);
  const branch = git(primary, "symbolic-ref", "--short", "-q", "HEAD");
  if (!branch.ok || branch.value !== main) return err("conflict", `--remove-knowledge: the primary checkout ${primary} is not on ${main}; check out ${main} there and run canon uninstall --remove-knowledge again (canon/ was left as it is)`);
  const st = git(primary, "status", "--porcelain", "--", "canon");
  if (!st.ok) return st;
  if (st.value !== "") return err("conflict", `--remove-knowledge: canon/ has uncommitted changes in ${primary}; commit or discard them and run again (canon/ was left as it is)`);
  for (const args of [["rm", "-r", "-q", "--", "canon"], ["commit", "-q", "-m", "Remove canon/ (canon uninstall --remove-knowledge)"]]) {
    const r = git(primary, ...args);
    if (!r.ok) return r;
  }
  say(`removed canon/ from ${main}`);
  if (config) pushTo(primary, config, say);
  return ok(true);
}

