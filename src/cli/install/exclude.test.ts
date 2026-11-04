import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "main.ts");
const LINE = "/.claude/worktrees/";

const src = mkdtempSync(join(tmpdir(), "canon-exclude-src-"));
mkdirSync(join(src, "canon-a"));
writeFileSync(join(src, "canon-a/SKILL.md"), "a v1\n");
const ENV = { CANON_SKILLS_SOURCE: src };

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test", ...ENV } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-exclude-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(root, ...args);
  return root;
}

const excludePath = (root: string) => join(root, ".git/info/exclude");
const linesOf = (root: string) => readFileSync(excludePath(root), "utf8").split("\n").filter((l) => l === LINE);

describe("canon init, install and update ignore Claude Code's subagent worktrees", () => {
  test("BR-2305: init creates a missing info/exclude with the line, and git then ignores .claude/worktrees", () => {
    const root = repo();
    rmSync(join(root, ".git/info"), { recursive: true, force: true });
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    expect(readFileSync(excludePath(root), "utf8")).toBe(`${LINE}\n`);
    mkdirSync(join(root, ".claude/worktrees/x"), { recursive: true });
    writeFileSync(join(root, ".claude/worktrees/x/f"), "f\n");
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).not.toContain(".claude/worktrees");
  });

  test("BR-2305: install and update after init add nothing: the line stays single and the file unchanged", () => {
    const root = repo();
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    const before = readFileSync(excludePath(root), "utf8");
    expect(canon(root, "install").code).toBe(0);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    expect(canon(root, "update").code).toBe(0);
    expect(readFileSync(excludePath(root), "utf8")).toBe(before);
    expect(linesOf(root)).toHaveLength(1);
  });

  test("BR-2305: an existing exclude file keeps its lines, including one without a final newline", () => {
    const root = repo();
    writeFileSync(excludePath(root), ".env");
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    expect(readFileSync(excludePath(root), "utf8")).toBe(`.env\n${LINE}\n`);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n");
  });

  test("BR-2305: install in a linked worktree writes the repository's common info/exclude", () => {
    const root = repo();
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    rmSync(excludePath(root));
    const wt = join(mkdtempSync(join(tmpdir(), "canon-exclude-wt-")), "wt");
    git(root, "worktree", "add", "-q", "-b", "side", wt);
    expect(canon(wt, "install").code).toBe(0);
    expect(linesOf(root)).toHaveLength(1);
    expect(existsSync(join(root, ".git/worktrees", "wt", "info/exclude"))).toBe(false);
  });

  test("BR-2305: update --check lists the missing line (exit 1); update writes it in place without a change; then --check is clean", () => {
    const root = repo();
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    expect(canon(root, "update", "--check").code).toBe(0);
    writeFileSync(excludePath(root), "");
    const head = git(root, "rev-parse", "HEAD");
    const check = canon(root, "update", "--check");
    expect(check.code).toBe(1);
    expect(check.out).toContain(`git exclude: ${LINE}`);
    const up = canon(root, "update");
    expect(up.code).toBe(0);
    expect(linesOf(root)).toHaveLength(1);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(canon(root, "update", "--check").code).toBe(0);
  });

  test("BR-2086: with the line missing and a skill out of date, update opens a change, lands the skill and writes the line", () => {
    const root = repo();
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const head = git(root, "rev-parse", "HEAD");
    writeFileSync(excludePath(root), "");
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    try {
      const up = canon(root, "update");
      expect(up.code).toBe(0);
      expect(git(root, "rev-parse", "HEAD")).not.toBe(head);
      expect(git(root, "show", "main:.claude/skills/canon-a/SKILL.md")).toBe("a v2");
      expect(linesOf(root)).toHaveLength(1);
    } finally {
      writeFileSync(join(src, "canon-a/SKILL.md"), "a v1\n");
    }
  });
});
