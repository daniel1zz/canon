import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitEnv, LFS_HINT } from "./git.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A repository whose .gitattributes sends *.bin through Git LFS, and a PATH that has git but no git-lfs. */
function lfsRepo(): { repo: string; path: string } {
  const base = mkdtempSync(join(tmpdir(), "canon-lfs-")); dirs.push(base);
  const bin = join(base, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("git")!, join(bin, "git"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q"], ["config", "filter.lfs.process", "git-lfs filter-process"], ["config", "filter.lfs.required", "true"], ["config", "filter.lfs.clean", "git-lfs clean -- %f"]]) expect(git(repo, ...args).ok).toBe(true);
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(repo, "a.bin"), "data\n");
  writeFileSync(join(repo, "a.txt"), "text\n");
  return { repo, path: bin };
}

test("BR-2650: a git command that fails because git-lfs is missing says so and how to install it; another git failure does not", () => {
  const { repo, path } = lfsRepo();
  const lfs = gitEnv(repo, { PATH: path }, "add", "a.bin");
  expect(lfs.ok).toBe(false);
  if (!lfs.ok) {
    expect(lfs.error.message).toContain("git-lfs: command not found");
    expect(lfs.error.message.endsWith(`\n${LFS_HINT}`)).toBe(true);
  }
  expect(gitEnv(repo, { PATH: path }, "add", "a.txt").ok).toBe(true);
  const other = gitEnv(repo, { PATH: path }, "rev-parse", "--verify", "no-such-ref");
  expect(other.ok).toBe(false);
  if (!other.ok) expect(other.error.message).not.toContain("git-lfs");
});

test("a git command in a directory that is gone fails as a result naming the directory, never throws", () => {
  const base = mkdtempSync(join(tmpdir(), "canon-gone-")); dirs.push(base);
  const gone = join(base, "removed-worktree");
  const r = git(gone, "status", "--porcelain");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.message).toBe(`git status --porcelain: ${gone} does not exist`);
});
