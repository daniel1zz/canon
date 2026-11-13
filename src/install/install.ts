import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { SKILL_DIRS, type AgentRuntime } from "../kernel/agent.ts";
import { git } from "../kernel/git.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * canon's Claude Code skills are project-level (D-9): they are copied into `<project>/.claude/skills/canon-*`
 * and committed with the project, so they load only in projects that use canon and never touch the user's
 * global ~/.claude. The source of truth is canon's own repository, `.claude/skills/canon-*`.
 *
 * A manifest (`.claude/skills/.canon-skills.json`) records the hash of every file canon wrote. An install
 * replaces a file only when it is still exactly what canon wrote last time; a file someone edited in the
 * project is never overwritten without --force (BR-2081), and the whole install is refused instead, so
 * nothing is half-updated.
 */
export const MANIFEST = ".canon-skills.json";
const PREFIX = "canon-";

export interface InstallReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  /** Edited in this project while canon has nothing newer: left as they are (BR-2089). */
  readonly kept: readonly string[];
}

const sha = (text: Buffer | string) => createHash("sha256").update(text).digest("hex");

/**
 * Where canon's skills come from (BR-2082): CANON_SKILLS_SOURCE when set (and only it), else the repository or package this canon
 * runs from (source checkout under `bun`; for the compiled `dist/canon`, the `dist/skills` published with it, else the repository
 * holding it; the npm package holding the bundled `dist/canon.js`). Missing → environment error.
 */
export function skillsSource(env: Record<string, string | undefined> = process.env, moduleDir: string = import.meta.dir, execPath: string = process.execPath): Result<string> {
  const explicit = env["CANON_SKILLS_SOURCE"];
  const bin = dirname(realpathSync(execPath));
  const published = join(bin, "skills");
  const candidates = explicit ? [explicit] : [
    join(moduleDir, "..", "..", ".claude", "skills"),
    // reason: the npm package bundles every source into dist/canon.js, so import.meta.dir is dist/ and the skills sit one level up (BR-2082).
    join(moduleDir, "..", ".claude", "skills"),
    // reason: a compiled canon installs the skills published with it from a tested, release-checked commit, not main's newest (BR-2082, D-91)
    published,
    join(bin, "..", ".claude", "skills"),
  ].filter((c): c is string => typeof c === "string" && c !== "");
  for (const c of candidates) {
    if (existsSync(c) && readdirSync(c).some((n) => n.startsWith(PREFIX))) return ok(c);
    // reason: a release that is there but broken must not fall back to the repository's unreviewed skills (BR-2082, BR-2412)
    if (c === published && (existsSync(c) || isBrokenLink(c))) return err("io", `${c} holds no canon-* skill (a broken release?); publish again with scripts/release.ts, or remove it to use the repository's skills`);
  }
  return err("io", `cannot find canon's skills (looked in: ${candidates.join(", ")}); set CANON_SKILLS_SOURCE to canon's .claude/skills`);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Whether `root` is canon's own repository, the one its skills come from (BR-2080): the target is the source itself, or the
 * source's repository (two levels up: `<repo>/.claude/skills`, or `<repo>/dist/skills-<commit>` behind the published
 * `dist/skills`, BR-2412) shares its git directory with `root`, as the primary checkout and its worktrees do.
 */
function isSourceRepository(root: string, target: string, source: string): boolean {
  if (resolve(target) === resolve(source)) return true;
  const home = dirname(dirname(realpathSync(source)));
  const common = (dir: string): string | undefined => {
    const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    return r.ok ? realpathSync(r.value) : undefined;
  };
  const mine = common(root);
  // reason: a source outside any repository (CANON_SKILLS_SOURCE, an npm package) is never the project's own (BR-2080)
  return mine !== undefined && existsSync(join(home, ".git")) && common(home) === mine;
}

/** A manifest key canon could have written: a relative path inside a `canon-*` skill, no `..`, no absolute path (BR-2083). */
function safeKey(rel: string): boolean {
  if (rel === "" || isAbsolute(rel) || rel.includes("\0")) return false;
  const n = normalize(rel);
  return n === rel && n.startsWith(PREFIX) && !n.split(sep).includes("..");
}

/** The first symlink on the way from `root` down to `full` (both included), if any (BR-2083). */
export function symlinkOnPath(root: string, full: string): string | undefined {
  const parts = relative(root, full).split(sep);
  let p = root;
  for (const part of parts) {
    p = join(p, part);
    if (!existsSync(p) && !isBrokenLink(p)) return undefined;
    if (lstatSync(p).isSymbolicLink()) return p;
  }
  return undefined;
}

function isBrokenLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The files under `<root>/.claude/skills` that canon wrote and nobody edited since: listed in the manifest with the hash of
 * their current content, as paths relative to `root` (BR-2410). A missing or unreadable manifest lists none, so every file
 * counts as the project's own and is reviewed as before.
 */
export function shippedUnedited(root: string): Set<string> {
  return new Set((["claude", "codex"] as const).flatMap((runtime) => [...shippedFor(root, runtime)]));
}

function shippedFor(root: string, runtime: AgentRuntime): Set<string> {
  const target = join(root, SKILL_DIRS[runtime]);
  const shipped = new Set<string>();
  let files: unknown;
  try {
    files = (JSON.parse(readFileSync(join(target, MANIFEST), "utf8")) as { files?: unknown } | null)?.files;
  } catch {
    return shipped;
  }
  if (files === null || typeof files !== "object") return shipped;
  for (const [rel, hash] of Object.entries(files as Record<string, unknown>)) {
    if (!safeKey(rel) || typeof hash !== "string") continue;
    const full = join(target, rel);
    if (existsSync(full) && !lstatSync(full).isSymbolicLink() && statSync(full).isFile() && sha(readFileSync(full)) === hash) shipped.add(`${SKILL_DIRS[runtime]}/${rel}`);
  }
  return shipped;
}

/** Every file of every `canon-*` skill in `source`, by path relative to `source`. */
function sourceFiles(source: string): Map<string, Buffer> {
  const wanted = new Map<string, Buffer>();
  for (const skill of readdirSync(source).filter((n) => n.startsWith(PREFIX) && statSync(join(source, n)).isDirectory())) {
    for (const f of filesUnder(join(source, skill))) wanted.set(relative(source, f), readFileSync(f));
  }
  return wanted;
}

/** A short id of a set of skill files: the same files always give the same version (BR-2084). */
export function versionOf(files: Readonly<Record<string, string>>): string {
  return sha(Object.keys(files).sort().map((k) => `${k} ${files[k]}`).join("\n")).slice(0, 10);
}

export interface SkillsStatus {
  /** current: the project has exactly canon's skills; outdated: some file differs or is missing; source: this is canon's own repository. */
  readonly state: "current" | "outdated" | "source";
  /** Version canon ships. */
  readonly version: string;
  /** Files an install would add, update or remove. */
  readonly outdated: readonly string[];
  /** Of those, files edited in the project (an install would refuse them, BR-2081). */
  readonly edited: readonly string[];
}

/** How the project's installed skills compare with the ones canon ships (BR-2084); reads only. */
export function skillsStatus(root: string, source: string, runtime: AgentRuntime = "claude"): Result<SkillsStatus> {
  const target = join(root, SKILL_DIRS[runtime]);
  const wanted = sourceFiles(source);
  const version = versionOf(Object.fromEntries([...wanted].map(([k, v]) => [k, sha(v)])));
  if (isSourceRepository(root, target, source)) return ok({ state: "source", version, outdated: [], edited: [] });
  let manifest: Record<string, string> = {};
  const manifestPath = join(target, MANIFEST);
  if (existsSync(manifestPath)) {
    try {
      manifest = (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, string> }).files ?? {};
    } catch {
      return err("invalid", `${relative(root, manifestPath)} is not valid JSON; fix or delete it`);
    }
  }
  const outdated: string[] = [];
  const edited: string[] = [];
  for (const [rel, content] of wanted) {
    const full = join(target, rel);
    if (!existsSync(full)) outdated.push(rel);
    else {
      const current = readFileSync(full);
      if (current.equals(content)) continue;
      // reason: edited here while canon kept the version it last installed: a local edit, not an update (BR-2089)
      if (manifest[rel] === sha(content)) continue;
      outdated.push(rel);
      if (manifest[rel] !== sha(current)) edited.push(rel);
    }
  }
  for (const rel of Object.keys(manifest)) {
    if (wanted.has(rel) || !safeKey(rel)) continue;
    const full = join(target, rel);
    if (!existsSync(full)) continue;
    outdated.push(rel);
    if (manifest[rel] !== sha(readFileSync(full))) edited.push(rel);
  }
  return ok({ state: outdated.length === 0 ? "current" : "outdated", version, outdated: outdated.sort(), edited: edited.sort() });
}

/** What an install would write, remove and keep, computed before anything is touched (BR-2081, BR-2083). */
export interface SkillsPlan {
  readonly target: string;
  readonly manifestPath: string;
  readonly wanted: ReadonlyMap<string, Buffer>;
  readonly write: readonly string[];
  readonly unchanged: readonly string[];
  readonly remove: readonly string[];
  readonly kept: readonly string[];
  /** Edited in this project and would be overwritten or deleted: the install is refused unless forced (BR-2081). */
  readonly conflicts: readonly string[];
  /** canon's own repository: the source is the target, nothing to write. */
  readonly source: boolean;
}

/** Reads only: refuses a bad manifest or a symlink on any path it would touch (exit 2), and lists the conflicts. */
export function planSkills(root: string, source: string, force: boolean, runtime: AgentRuntime = "claude"): Result<SkillsPlan> {
  const target = join(root, SKILL_DIRS[runtime]);
  const manifestPath = join(target, MANIFEST);
  if (isSourceRepository(root, target, source)) {
    return ok({ target, manifestPath, wanted: new Map(), write: [], unchanged: [], remove: [], kept: [], conflicts: [], source: true });
  }

  const wanted = sourceFiles(source);
  let manifest: Record<string, string> = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, string> }).files ?? {};
    } catch {
      return err("invalid", `${relative(root, manifestPath)} is not valid JSON; fix or delete it`);
    }
    const bad = Object.keys(manifest).filter((k) => !safeKey(k));
    if (bad.length > 0) return err("invalid", `${relative(root, manifestPath)} lists paths canon never writes (${bad.join(", ")}); fix or delete it`);
  }
  // Nothing is written or deleted through a symlink: a committed link could point outside the project (BR-2083).
  const touched = [...wanted.keys(), ...Object.keys(manifest)].map((rel) => join(target, rel));
  for (const full of [manifestPath, ...touched]) {
    const link = symlinkOnPath(root, full);
    if (link) return err("invalid", `${relative(root, link)} is a symbolic link; canon writes skills only as plain files inside the project. Replace the link with a directory and run again.`);
  }

  const write: string[] = [];
  const unchanged: string[] = [];
  const remove: string[] = [];
  const conflicts: string[] = [];
  const kept: string[] = [];
  for (const [rel, content] of wanted) {
    const full = join(target, rel);
    if (!existsSync(full)) write.push(rel);
    else {
      const current = readFileSync(full);
      if (current.equals(content)) unchanged.push(rel);
      else if (manifest[rel] === sha(current) || force) write.push(rel);
      else if (manifest[rel] === sha(content)) kept.push(rel); // reason: canon has nothing new for it; keep the local edit (BR-2089)
      else conflicts.push(rel);
    }
  }
  for (const rel of Object.keys(manifest)) {
    if (wanted.has(rel)) continue;
    const full = join(target, rel);
    if (!existsSync(full)) continue;
    if (manifest[rel] === sha(readFileSync(full)) || force) remove.push(rel);
    else conflicts.push(rel);
  }
  return ok({ target, manifestPath, wanted, write, unchanged, remove, kept, conflicts, source: false });
}

/** The refusal for skill files edited here that an install would overwrite (BR-2081). */
export function editedSkills(conflicts: readonly string[], rerun: string, runtime: AgentRuntime = "claude"): Result<never> {
  return err("conflict", `these canon skill files were edited in this project and would be overwritten:\n${conflicts.map((c) => `  ${SKILL_DIRS[runtime]}/${c}`).join("\n")}\nMove the edits into canon itself, or ${rerun} to discard them.`);
}

/** Writes a plan that has no conflicts (or was forced). */
export function applySkills(plan: SkillsPlan): InstallReport {
  if (plan.source) return { written: [], unchanged: [], removed: [], kept: [] };
  for (const rel of plan.write) {
    const full = join(plan.target, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, plan.wanted.get(rel)!);
  }
  for (const rel of plan.remove) rmSync(join(plan.target, rel));
  const files = Object.fromEntries([...plan.wanted].map(([rel, content]) => [rel, sha(content)]));
  mkdirSync(plan.target, { recursive: true });
  writeFileSync(plan.manifestPath, `${JSON.stringify({ note: "Written by canon install; edit the skills in canon, not here.", version: versionOf(files), files }, null, 2)}\n`);
  return { written: plan.write, unchanged: plan.unchanged, removed: plan.remove, kept: plan.kept };
}

/** What `canon uninstall` removes from `.claude/skills` (BR-2278, BR-2279), computed before anything is touched. */
export interface UnskillPlan {
  readonly target: string;
  readonly manifestPath: string;
  /** Files the manifest lists that are still there: unchanged ones, plus edited ones when forced. */
  readonly remove: readonly string[];
  /** Listed files edited in this project: refused unless forced (BR-2279). */
  readonly edited: readonly string[];
  readonly manifest: boolean;
}

/** Reads only: refuses a bad manifest (BR-2195) or a symlink on any path it would delete (BR-2083). */
export function planUnskills(root: string, force: boolean, runtime: AgentRuntime = "claude"): Result<UnskillPlan> {
  const target = join(root, SKILL_DIRS[runtime]);
  const manifestPath = join(target, MANIFEST);
  if (!existsSync(manifestPath)) return ok({ target, manifestPath, remove: [], edited: [], manifest: false });
  let manifest: Record<string, string>;
  try {
    manifest = (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, string> }).files ?? {};
  } catch {
    return err("invalid", `${relative(root, manifestPath)} is not valid JSON; fix or delete it`);
  }
  const bad = Object.keys(manifest).filter((k) => !safeKey(k));
  if (bad.length > 0) return err("invalid", `${relative(root, manifestPath)} lists paths canon never writes (${bad.join(", ")}); fix or delete it`);
  for (const full of [manifestPath, ...Object.keys(manifest).map((rel) => join(target, rel))]) {
    const link = symlinkOnPath(root, full);
    if (link) return err("invalid", `${relative(root, link)} is a symbolic link; canon deletes skills only as plain files inside the project`);
  }
  const remove: string[] = [];
  const edited: string[] = [];
  for (const rel of Object.keys(manifest).sort()) {
    const full = join(target, rel);
    if (!existsSync(full)) continue;
    const same = manifest[rel] === sha(readFileSync(full));
    if (!same) edited.push(rel);
    if (same || force) remove.push(rel);
  }
  return ok({ target, manifestPath, remove, edited, manifest: true });
}

/** Deletes what planUnskills listed, the manifest, and every directory that removal left empty; returns the files removed. */
export function applyUnskills(plan: UnskillPlan): readonly string[] {
  for (const rel of plan.remove) {
    rmSync(join(plan.target, rel));
    // reason: only directories this removal emptied go; one holding the project's own files stays (BR-2279)
    for (let d = dirname(join(plan.target, rel)); d !== plan.target && d.startsWith(plan.target + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmSync(d, { recursive: true });
    }
  }
  if (plan.manifest) rmSync(plan.manifestPath);
  if (existsSync(plan.target) && readdirSync(plan.target).length === 0) rmSync(plan.target, { recursive: true });
  return plan.remove;
}

/** Copies every `canon-*` skill from `source` into `<root>/.claude/skills`, keeping local edits safe; plans first, so a conflict refuses the whole install and nothing is half-updated. */
export function installSkills(root: string, source: string, force: boolean, runtime: AgentRuntime = "claude"): Result<InstallReport> {
  const plan = planSkills(root, source, force, runtime);
  if (!plan.ok) return plan;
  if (plan.value.conflicts.length > 0) return editedSkills(plan.value.conflicts, "run again with --force", runtime);
  return ok(applySkills(plan.value));
}
