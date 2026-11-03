import { defineCommand } from "citty";
import { MODELINE } from "../../config/reference/reference.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entry, EXIT, must, say, workspace, type DomainCommands } from "../command.ts";
import { git } from "../../kernel/git.ts";
import type { Workspace } from "../../work/workspace.ts";
import { skillsSource, type InstallReport } from "./install.ts";
import { assetsStatus, installAssets, updateNotice, updateProject } from "./update.ts";

/** `canon init`, `install`, `update`: canon's own files in a project (D-9, D-10). */

const init = defineCommand({
  meta: { description: "Create the canon/ layout in this repository" },
  args: { floor: { type: "string", description: "Command that must pass before anything lands, e.g. \"bun run typecheck && bun test\"" } },
  run({ args }) {
    const root = must(git(process.cwd(), "rev-parse", "--show-toplevel"));
    // Skills first: a missing source (BR-2082) or an edited skill copy (BR-2081) refuses before anything else is written.
    reportInstall(must(installAssets(root, must(skillsSource()), false)));
    const files: Record<string, string> = {
      "canon/product.md": "---\ntitle: 产品\n---\n# 产品\n\n## 目的\n\n## 使用者\n\n## 承诺\n\n## 不做的事\n",
      "canon/config.yaml": `${MODELINE}\nmain: main\nfloor: ${JSON.stringify(args.floor ?? "")}\n`,
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
  },
});

function reportInstall(r: InstallReport & { hook: boolean; guard: boolean }) {
  for (const f of r.written) say(`skill ${f}`);
  for (const f of r.removed) say(`removed skill file ${f}`);
  for (const f of r.kept) say(`kept skill ${f} (edited in this project; canon has no newer version)`);
  if (r.hook) say("hooks: .claude/settings.json brought up to date (canon brief at session start; entries canon withdrew removed)");
  if (r.guard) say("git hook: main moves only through canon work land (reference-transaction; not tracked, nothing to commit)");
  const tracked = r.written.length + r.removed.length > 0 || r.hook;
  say(tracked ? "canon project files installed; commit them with the project" : r.guard ? "canon project files installed" : "canon project files: up to date");
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
    if (out.kind === "guard") return say(`git hook installed: main moves only through canon work land; canon project files are now up to date (version ${out.version})`);
    if (out.kind === "landed") return say(`updated to ${out.version} in ${out.change}, landed ${out.sha.slice(0, 9)}`);
    console.error(`canon: the update ${out.change} did not land: ${out.message}`);
    // reason: still queued is a timeout, not a refusal: the caller runs the landing again (BR-2022)
    process.exit(out.kind === "timeout" ? EXIT.timeout : EXIT.refused);
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
  commands: [entry("init", 10, init), entry("install", 160, install), entry("update", 170, update)],
};
