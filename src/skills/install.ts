import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

/** Copies every `canon-*` skill from `source` into `<root>/.claude/skills`, keeping local edits safe. */
export function installSkills(root: string, source: string, force: boolean): Result<InstallReport> {
  const target = join(root, ".claude", "skills");
  if (existsSync(target) && realpathSync(target) === realpathSync(source)) return ok({ written: [], unchanged: [], removed: [] });

  const wanted = new Map<string, Buffer>();
  for (const skill of readdirSync(source).filter((n) => n.startsWith(PREFIX) && statSync(join(source, n)).isDirectory())) {
    for (const f of filesUnder(join(source, skill))) wanted.set(relative(source, f), readFileSync(f));
  }
  const manifestPath = join(target, MANIFEST);
  let manifest: Record<string, string> = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, string> }).files ?? {};
    } catch {
      return err("invalid", `${relative(root, manifestPath)} is not valid JSON; fix or delete it`);
    }
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
  writeFileSync(manifestPath, `${JSON.stringify({ note: "Written by canon skills install; edit the skills in canon, not here.", files }, null, 2)}\n`);
  return ok({ written: write, unchanged, removed: remove });
}
