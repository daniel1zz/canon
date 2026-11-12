import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), "canon-init-"));
  sh(root, "init", "-q", "-b", branch);
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  return root;
}

const configOf = (root: string) => readFileSync(join(root, "canon/config.yaml"), "utf8");
const guardOf = (root: string) => readFileSync(join(root, sh(root, "rev-parse", "--git-path", "hooks"), "reference-transaction"), "utf8");

describe("canon init names main after the current branch", () => {
  test("BR-2032: on branch trunk the config says main: trunk and the guard protects trunk; on main it says main", () => {
    const trunk = repo("trunk");
    writeFileSync(join(trunk, "a.txt"), "a\n");
    sh(trunk, "add", "-A");
    sh(trunk, "commit", "-qm", "first");
    expect(canon(trunk, "init", "--floor", "true").code).toBe(0);
    expect(configOf(trunk)).toContain('main: "trunk"\n');
    expect(guardOf(trunk)).toContain("refs/heads/trunk");
    const main = repo("main");
    expect(canon(main, "init", "--floor", "true").code).toBe(0);
    expect(configOf(main)).toContain('main: "main"\n');
  });

  test("BR-2032 BR-2046: init writes tests: [] under a comment, so canon check works in a new project and says where the globs go", () => {
    const root = repo("main");
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    expect(configOf(root)).toMatch(/\n# [^\n]*test_command[^\n]*\ntests: \[\]\n/);
    expect(canon(root, "check").code).toBe(0);
  });

  test("BR-2032: init writes canon/architecture.md with only its three headings and never overwrites one; canon check accepts it", () => {
    const root = repo("main");
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    const overview = join(root, "canon/architecture.md");
    expect(readFileSync(overview, "utf8")).toBe("---\ntitle: 架构总览\n---\n# 架构总览\n\n## 上下文\n\n## 容器\n\n## 主要流程\n");
    expect(canon(root, "check").code).toBe(0);
    writeFileSync(overview, "mine\n");
    const again = canon(root, "init", "--floor", "true");
    expect(again.out).toContain("exists canon/architecture.md");
    expect(readFileSync(overview, "utf8")).toBe("mine\n");
  });

  test("BR-2032: a repository with no commits yet uses its unborn branch", () => {
    const root = repo("dev");
    expect(canon(root, "init").code).toBe(0);
    expect(configOf(root)).toContain('main: "dev"\n');
  });

  test("BR-2032: init in a repository with no commit says to commit the written files; with a commit it does not (issue #123)", () => {
    const empty = repo("main");
    const r = canon(empty, "init", "--floor", "true");
    expect(r.code).toBe(0);
    expect(r.out).toContain("main has no commit yet");
    expect(r.out).toContain('git commit -m "canon init"');
    const born = repo("main");
    sh(born, "commit", "-q", "--allow-empty", "-m", "first");
    const again = canon(born, "init", "--floor", "true");
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("has no commit yet");
  });

  test("BR-2032: with a commit on main init writes main's commit as links_since, so canon links works at once; with none it leaves it out and says canon update writes it", () => {
    const born = repo("main");
    sh(born, "commit", "-q", "--allow-empty", "-m", "first");
    const r = canon(born, "init", "--floor", "true");
    expect(r.code).toBe(0);
    expect(configOf(born)).toMatch(new RegExp(`\n# [^\n]+\nlinks_since: "${sh(born, "rev-parse", "main")}"\n$`));
    expect(r.out).not.toContain("links_since");
    expect(canon(born, "links", "list").code).toBe(0);
    const empty = repo("main");
    const e = canon(empty, "init", "--floor", "true");
    expect(e.code).toBe(0);
    expect(configOf(empty)).not.toContain("links_since");
    expect(e.out).toContain("links_since is left out");
    expect(e.out).toContain("canon update");
  });

  test("BR-2032: init leaves an existing canon/config.yaml without links_since as it is", () => {
    const root = repo("main");
    sh(root, "commit", "-q", "--allow-empty", "-m", "first");
    mkdirSync(join(root, "canon"), { recursive: true });
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\n');
    const r = canon(root, "init", "--floor", "true");
    expect(r.code).toBe(0);
    expect(configOf(root)).toBe('floor: "true"\ntests: []\n');
    expect(r.out).not.toContain("links_since");
  });

  test("BR-2032 BR-2022: a detached HEAD without canon/config.yaml refuses with 4 and writes nothing", () => {
    const root = repo("main");
    sh(root, "commit", "-q", "--allow-empty", "-m", "first");
    sh(root, "checkout", "-q", "--detach");
    const r = canon(root, "init", "--floor", "true");
    expect(r.code).toBe(4);
    expect(r.err).toContain("detached");
    expect(existsSync(join(root, "canon"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills"))).toBe(false);
  });

  test("BR-2032 BR-2124: a detached HEAD refuses with 4 before someone else's git hook would refuse with 5", () => {
    const root = repo("main");
    sh(root, "commit", "-q", "--allow-empty", "-m", "first");
    sh(root, "checkout", "-q", "--detach");
    const hook = join(root, sh(root, "rev-parse", "--git-path", "hooks"), "reference-transaction");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(canon(root, "init").code).toBe(4);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("BR-2032: a detached HEAD with canon/config.yaml already there runs and leaves the config as it was", () => {
    const root = repo("main");
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon/config.yaml"), 'main: "trunk"\nfloor: "true"\n');
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "first");
    sh(root, "checkout", "-q", "--detach");
    const r = canon(root, "init");
    expect(r.code).toBe(0);
    expect(r.out).toContain("exists canon/config.yaml");
    expect(configOf(root)).toBe('main: "trunk"\nfloor: "true"\n');
    expect(guardOf(root)).toContain("refs/heads/trunk");
  });
});
