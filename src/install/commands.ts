import { defineCommand } from "citty";
import { MODELINE } from "../invocation/reference/reference.ts";
import { DEFAULT_REVIEW, REVIEW_NONE } from "../knowledge/review/config-keys.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { entry, EXIT, fail, must, say, workspace, type DomainCommands } from "../invocation/command.ts";
import { firstCommitStep, git, mainIsUnborn } from "../kernel/git.ts";
import type { Workspace } from "../work/workspace.ts";
import { REPORT_UPDATE_NOTE } from "../work/verify/report.ts";
import { skillsSource, type InstallReport } from "./install.ts";
import { ARCHITECTURE_TEMPLATE, assetsStatus, installAssets, updateNotice, updateProject, WORKTREES_EXCLUDE } from "./update.ts";
import { uninstall as uninstallProject } from "./uninstall.ts";

/** `canon init`, `install`, `update`: canon's own files in a project (D-9, D-10). */

const init = defineCommand({
  meta: { description: "Create the canon/ layout in this repository" },
  args: { floor: { type: "string", description: "Command that must pass before anything lands, e.g. \"bun run typecheck && bun test\"" } },
  run({ args }) {
    const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
    // The branch checked out now becomes main; it is only needed when init is about to write canon/config.yaml (BR-2032).
    const branch = existsSync(join(root, "canon/config.yaml")) ? undefined : currentBranch(root);
    // Skills first: a missing source (BR-2082) or an edited skill copy (BR-2081) refuses before anything else is written.
    reportInstall(must(installAssets(root, must(skillsSource()), false, branch)));
    const files: Record<string, string> = {
      "canon/product.md": "---\ntitle: 产品\n---\n# 产品\n\n## 目的\n\n## 使用者\n\n## 承诺\n\n## 不做的事\n",
      "canon/architecture.md": ARCHITECTURE_TEMPLATE,
      "canon/config.yaml": `${MODELINE}\nmain: ${JSON.stringify(branch ?? "main")}\nfloor: ${JSON.stringify(args.floor ?? "")}\n${TESTS_COMMENT}\ntests: []\n${REVIEW_COMMENT}\nreview: ${JSON.stringify(DEFAULT_REVIEW)}\n`,
    };
    for (const [p, text] of Object.entries(files)) {
      const full = join(root, p);
      if (existsSync(full)) say(`exists ${p}`);
      else {
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, text);
        say(`created ${p}`);
      }
    }
    for (const dir of ["rules", "decisions", "changes", "notes"]) mkdirSync(join(root, "canon", dir), { recursive: true });
    if (!args.floor) say("set `floor` in canon/config.yaml before landing anything");
    // reason: BR-2032 — until main has a commit no change can start (BR-2012); say so while the files are fresh
    const main = branch ?? configuredMain(root);
    if (main && mainIsUnborn(root, main)) say(`${main} has no commit yet: ${firstCommitStep(main)}`);
  },
});

/** The line above the reviewer init writes: what it reviews and how to turn it off on purpose (BR-2032, BR-2074). */
// reason: canon/ documents are written in Chinese, like the product.md init writes (CLAUDE.md)
// reason: canon does not guess which files are tests (BR-2046, D-64), so a new project starts with an empty list that canon check accepts and a comment that says what goes there
const TESTS_COMMENT = "# 项目的测试文件的 glob（任何语言），例如 [\"src/**/*.test.ts\"]；canon 从 test_command 写出的 JUnit 报告读出文件里有哪些测试、跑没跑（D-64）";
const REVIEW_COMMENT = `# 合入时评审规则、决策和常驻说明的改动（从标准输入读提示，在标准输出给出结论 JSON）；没有配置时这样的合入被拒，有意不评审时写 review: ${REVIEW_NONE}`;

/** The branch HEAD is on, also in a repository with no commits yet; a detached HEAD refuses with exit 4 (BR-2032). */
function currentBranch(root: string): string {
  const r = git(root, "symbolic-ref", "--short", "-q", "HEAD");
  if (r.ok && r.value) return r.value;
  return fail({ code: "io", message: "HEAD is detached: check out the branch that is to be main, then run canon init again (it becomes `main` in canon/config.yaml)" });
}

/** `main` of an existing canon/config.yaml; undefined when the file does not name one (the other commands report that). */
function configuredMain(root: string): string | undefined {
  try {
    const main = (parse(readFileSync(join(root, "canon/config.yaml"), "utf8")) as { main?: unknown } | null)?.main;
    return typeof main === "string" ? main : undefined;
  } catch {
    return undefined;
  }
}

function reportInstall(r: InstallReport & { hook: boolean; guard: boolean; exclude: boolean }) {
  for (const f of r.written) say(`skill ${f}`);
  for (const f of r.removed) say(`removed skill file ${f}`);
  for (const f of r.kept) say(`kept skill ${f} (edited in this project; canon has no newer version)`);
  if (r.hook) say("hooks: .claude/settings.json brought up to date (canon brief at session start; entries canon withdrew removed)");
  if (r.guard) say("git hook: main moves only through canon work land (reference-transaction; not tracked, nothing to commit)");
  if (r.exclude) say(`git exclude: ${WORKTREES_EXCLUDE} added to the repository's info/exclude (not tracked, nothing to commit)`);
  const tracked = r.written.length + r.removed.length > 0 || r.hook;
  say(tracked ? "canon project files installed; commit them with the project" : r.guard || r.exclude ? "canon project files installed" : "canon project files: up to date");
}

/** Installs canon's project files (skills, session hook) into this tree, as `canon init` does (D-9, D-10). */
const install = defineCommand({
  meta: { description: "Install canon's project files (skills, session-start hook, the git hook that keeps main moving only through canon work land) into this tree; files edited here are not overwritten without --force" },
  args: { force: { type: "boolean", description: "Overwrite skill files that were edited in this project" } },
  run({ args }) {
    const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
    reportInstall(must(installAssets(root, must(skillsSource()), Boolean(args.force))));
  },
});

/** Discovery is automatic (brief, work start); updating happens only when someone asks for it (D-10). */
const update = defineCommand({
  meta: { description: "Update canon's project files to this canon's version as its own landed change; --check only reports" },
  args: {
    check: { type: "boolean", description: "Only report what is out of date; exit 1 when something is" },
    force: { type: "boolean", description: "Overwrite skill files that were edited in this project" },
  },
  async run({ args }) {
    if (args.check) {
      // reason: --check only reads, so it does not open (and so create) the coordination database (BR-2084)
      const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
      const st = must(assetsStatus(root, must(skillsSource())));
      if (st.current) return say(`canon project files: up to date (version ${st.version})`);
      say(`canon project files are out of date (version ${st.version}):`);
      for (const o of st.outdated) say(`  ${o}${st.edited.some((e) => o === `skill ${e}`) ? "  (edited in this project)" : ""}`);
      process.exit(EXIT.refused);
    }
    const ws = workspace();
    const out = must(await updateProject(ws, must(skillsSource()), Boolean(args.force), ws.config.landTimeoutMs, say));
    if (out.kind === "current") return say(`canon project files: up to date (version ${out.version})`);
    if (out.kind === "local") {
      const what = [out.guard ? "git hook installed: main moves only through canon work land" : "", out.exclude ? `git exclude: ${WORKTREES_EXCLUDE} added to info/exclude` : ""].filter(Boolean).join("; ");
      say(`${what}; canon project files are now up to date (version ${out.version})`);
      return say(REPORT_UPDATE_NOTE);
    }
    if (out.kind === "landed") {
      say(`updated to ${out.version} in ${out.change}, landed ${out.sha.slice(0, 9)}`);
      return say(REPORT_UPDATE_NOTE);
    }
    console.error(`canon: the update ${out.change} did not land: ${out.message}`);
    // reason: still queued is a timeout, not a refusal: the caller runs the landing again (BR-2022)
    process.exit(out.kind === "timeout" ? EXIT.timeout : EXIT.refused);
  },
});

/** Removes canon from the project (D-46): one landed change, then the local cleanup in each clone. */
const uninstall = defineCommand({
  meta: { description: "Remove canon from this project: lands one change deleting canon's skills, its .claude/settings.json entries and canon/config.yaml once no work is in flight, then removes the git hook, worktrees, coordination state and refs in this clone; in another clone after that change, only the local cleanup. canon/ documents and recovery refs stay unless asked" },
  args: {
    force: { type: "boolean", description: "Also delete canon skill files that were edited in this project" },
    "purge-recovery": { type: "boolean", description: "Also delete refs/canon/archive (work canon work drop kept) and refs/canon/snapshots" },
    "remove-knowledge": { type: "boolean", description: "Also remove canon/ (rules, decisions, changes, notes) from main in a commit of its own" },
    timeout: { type: "string", description: "Minutes to wait in the landing queue (default: land_timeout_minutes, 60)" },
  },
  async run({ args }) {
    const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
    const out = must(await uninstallProject(process.cwd(), { force: Boolean(args.force), purgeRecovery: Boolean(args["purge-recovery"]), removeKnowledge: Boolean(args["remove-knowledge"]), timeoutMs: minutes === undefined ? undefined : minutes * 60_000 }, say));
    if (out.kind === "done") return say("canon is uninstalled from this clone");
    if (out.kind === "not-installed") return say("canon is not installed here");
    console.error(`canon: ${out.message}`);
    // reason: still queued or background commands still running is "later", not a refusal (BR-2022, BR-2283)
    process.exit(out.kind === "refused" ? EXIT.refused : EXIT.timeout);
  },
});

/** The update notice (BR-2085); a missing skills source is reported on the same line, never hidden. */
export function noticeUpdates(ws: Workspace, out: (line: string) => void) {
  const source = skillsSource();
  if (!source.ok) return out(`canon project files: cannot check for updates (${source.error.message})`);
  const st = assetsStatus(ws.root, source.value);
  if (!st.ok) return out(`canon project files: cannot check for updates (${st.error.message})`);
  const n = updateNotice(st.value);
  if (n) out(n);
}

export const installCommands: DomainCommands = {
  commands: [entry("init", 10, init), entry("install", 160, install), entry("update", 170, update), entry("uninstall", 175, uninstall)],
};
