import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
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
}

const sha = (text: Buffer | string) => createHash("sha256").update(text).digest("hex");

/**
 * Where canon's skills come from (BR-2082): CANON_SKILLS_SOURCE when set (and only it), else the repository this canon runs from
 * (source checkout under `bun`, or the repository holding the compiled `dist/canon`). Missing → environment error.
 */
export function skillsSource(env: Record<string, string | undefined> = process.env): Result<string> {
  const explicit = env["CANON_SKILLS_SOURCE"];
  const candidates = explicit ? [explicit] : [
    join(import.meta.dir, "..", "..", ".claude", "skills"),
    join(dirname(realpathSync(process.execPath)), "..", ".claude", "skills"),
  ].filter((c): c is string => typeof c === "string" && c !== "");
  for (const c of candidates) {
    if (existsSync(c) && readdirSync(c).some((n) => n.startsWith(PREFIX))) return ok(c);
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

/** A manifest key canon could have written: a relative path inside a `canon-*` skill, no `..`, no absolute path (BR-2083). */
function safeKey(rel: string): boolean {
  if (rel === "" || isAbsolute(rel) || rel.includes("\0")) return false;
  const n = normalize(rel);
  return n === rel && n.startsWith(PREFIX) && !n.split(sep).includes("..");
}

/** The first symlink on the way from `root` down to `full` (both included), if any (BR-2083). */
function symlinkOnPath(root: string, full: string): string | undefined {
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
export function skillsStatus(root: string, source: string): Result<SkillsStatus> {
  const target = join(root, ".claude", "skills");
  const wanted = sourceFiles(source);
  const version = versionOf(Object.fromEntries([...wanted].map(([k, v]) => [k, sha(v)])));
  if (existsSync(target) && realpathSync(target) === realpathSync(source)) return ok({ state: "source", version, outdated: [], edited: [] });
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

/** Copies every `canon-*` skill from `source` into `<root>/.claude/skills`, keeping local edits safe. */
export function installSkills(root: string, source: string, force: boolean): Result<InstallReport> {
  const target = join(root, ".claude", "skills");
  if (existsSync(target) && realpathSync(target) === realpathSync(source)) return ok({ written: [], unchanged: [], removed: [] });

  const wanted = sourceFiles(source);
  const manifestPath = join(target, MANIFEST);
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

  // Plan first, so a conflict refuses the whole install and nothing is half-updated.
  const write: string[] = [];
  const unchanged: string[] = [];
  const remove: string[] = [];
  const conflicts: string[] = [];
  for (const [rel, content] of wanted) {
    const full = join(target, rel);
    if (!existsSync(full)) write.push(rel);
    else {
      const current = readFileSync(full);
      if (current.equals(content)) unchanged.push(rel);
      else if (manifest[rel] === sha(current) || force) write.push(rel);
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
  if (conflicts.length > 0) {
    return err("conflict", `these canon skill files were edited in this project and would be overwritten:\n${conflicts.map((c) => `  .claude/skills/${c}`).join("\n")}\nMove the edits into canon itself, or run again with --force to discard them.`);
  }

  for (const rel of write) {
    const full = join(target, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, wanted.get(rel)!);
  }
  for (const rel of remove) rmSync(join(target, rel));
  const files = Object.fromEntries([...wanted].map(([rel, content]) => [rel, sha(content)]));
  mkdirSync(target, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({ note: "Written by canon skills install; edit the skills in canon, not here.", version: versionOf(files), files }, null, 2)}\n`);
  return ok({ written: write, unchanged, removed: remove });
}
