import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git } from "../kernel/git.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * Publishing a canon release into a checkout's `dist/` (BR-2412, D-91): the compiled `dist/canon` and the skills it installs,
 * `dist/skills`, both from the same tested commit. `dist/skills` is a symbolic link to `skills-<commit>`, switched by one
 * rename, so a reader sees the old set or the new one, never half of each (D-55); the binary is written beside and renamed
 * over the old one. Skills are read from `dist/skills` by a compiled canon (BR-2082), so projects receive what was published,
 * not whatever main holds now.
 */
export const SKILLS_LINK = "skills";
const PREFIX = "canon-";

export interface PublishEnv {
  /** The checkout whose `dist/` receives the release. */
  readonly primary: string;
  /** A checkout of `green`, holding the skills to publish. */
  readonly cwd: string;
  /** The tested commit being published. */
  readonly green: string;
  /** Writes the compiled canon to `outfile`. */
  readonly build: (outfile: string) => Result<void>;
}

export type PublishOutcome = { readonly kind: "published"; readonly skills: string } | { readonly kind: "older"; readonly published: string };

/** The commit the current `dist/skills` was published from, if it is a link canon made. */
export function publishedCommit(dist: string): string | undefined {
  const link = join(dist, SKILLS_LINK);
  if (!isLink(link)) return undefined;
  return readlinkSync(link).match(/^skills-([0-9a-f]{7,64})$/)?.[1];
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function publishRelease(e: PublishEnv): Result<PublishOutcome> {
  const dist = join(e.primary, "dist");
  mkdirSync(dist, { recursive: true });
  const link = join(dist, SKILLS_LINK);
  if (existsSync(link) && !isLink(link)) return err("io", `${link} is not a symbolic link; canon publishes skills only by switching that link. Move it away and run again.`);
  const before = publishedCommit(dist);
  // reason: two after_green runs may overlap; only a newer commit may replace what is published (BR-2222, D-55)
  if (before !== undefined && before !== e.green) {
    const older = git(e.cwd, "merge-base", "--is-ancestor", e.green, before);
    if (older.ok) return ok({ kind: "older", published: before });
  }
  const tmpBin = join(dist, `canon.tmp-${process.pid}`);
  const built = e.build(tmpBin);
  if (!built.ok) {
    rmSync(tmpBin, { force: true });
    return built;
  }
  const name = `skills-${e.green}`;
  const target = join(dist, name);
  if (!existsSync(target)) {
    const tmpDir = join(dist, `${name}.tmp-${process.pid}`);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const src = join(e.cwd, ".claude", "skills");
    const skills = existsSync(src) ? readdirSync(src).filter((n) => n.startsWith(PREFIX)) : [];
    if (skills.length === 0) {
      rmSync(tmpBin, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
      return err("io", `no canon-* skill under ${src}; nothing published`);
    }
    try {
      for (const s of skills) cpSync(join(src, s), join(tmpDir, s), { recursive: true });
      renameSync(tmpDir, target);
    } catch (e) {
      rmSync(tmpBin, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
      return err("io", `copying the skills into ${tmpDir} failed: ${(e as Error).message}`);
    }
  }
  // reason: a failed rename is an environment error the caller reports (exit 4), never an uncaught throw (BR-2412)
  try {
    const tmpLink = join(dist, `${SKILLS_LINK}.tmp-${process.pid}`);
    rmSync(tmpLink, { force: true });
    symlinkSync(name, tmpLink);
    renameSync(tmpLink, link);
    renameSync(tmpBin, join(dist, "canon"));
  } catch (e) {
    rmSync(tmpBin, { force: true });
    return err("io", `publishing into ${dist} failed: ${(e as Error).message}`);
  }
  // Older releases go, except the one published just before: a reader may still be walking it.
  const keep = new Set([name, before === undefined ? "" : `skills-${before}`]);
  for (const n of readdirSync(dist)) if (/^skills-[0-9a-f]+$/.test(n) && !keep.has(n)) rmSync(join(dist, n), { recursive: true, force: true });
  return ok({ kind: "published", skills: link });
}
