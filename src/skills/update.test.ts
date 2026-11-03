import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-update-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function canon(cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test", ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();

/** A canon project initialised from a fixture skills source and committed on main. */
function project() {
  const src = dir({ "canon-a/SKILL.md": "a v1\n", "canon-b/SKILL.md": "b v1\n" });
  const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(root, ...args);
  const env = { CANON_SKILLS_SOURCE: src };
  expect(canon(root, env, "init", "--floor", "true").code).toBe(0);
  writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\n');
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return { src, root, env };
}

describe("finding and applying updates", () => {
  test("BR-2084: --check reports up to date, then lists what is out of date (and what was edited here) with exit 1", () => {
    const { src, root, env } = project();
    const ok = canon(root, env, "update", "--check");
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining("up to date")]);
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n");
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("skill canon-a/SKILL.md");
    expect(r.out).toContain("skill canon-b/SKILL.md  (edited in this project)");
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v1\n"); // --check changes nothing
  });

  test("BR-2084 BR-2087: a project without the session hook is out of date", () => {
    const { root, env } = project();
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { allow: [] } }));
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hook: canon brief at session start");
  });

  test("BR-2085: brief and work start print one notice line when something is out of date, and nothing about it when current", () => {
    const { src, root, env } = project();
    expect(canon(root, env, "brief").out).not.toContain("out of date");
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    const b = canon(root, env, "brief").out;
    expect(b.split("\n").filter((l) => l.includes("out of date"))).toEqual([expect.stringContaining("tell the user; when they want it, run `canon update`")]);
    expect(canon(root, env, "work", "start", "--title", "Other work").out).toContain("canon update");
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v1\n"); // discovery never updates
  });

  test("BR-2086: update lands as its own change through the normal landing, and is a no-op when current", () => {
    const { src, root, env } = project();
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    const r = canon(root, env, "update");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/updated to \w+ in C-\d+, landed/);
    expect(git(root, "show", "main:.claude/skills/canon-a/SKILL.md")).toBe("a v2");
    expect(git(root, "log", "-1", "--format=%s", "main")).toMatch(/^canon: close C-\d+$/);
    expect(canon(root, env, "update", "--check").code).toBe(0);
    expect(canon(root, env, "update").out).toContain("up to date");
  });

  test("BR-2086: an update that would overwrite a file edited here is refused before any change is opened", () => {
    const { src, root, env } = project();
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    git(root, "commit", "-qam", "local edit");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n");
    const r = canon(root, env, "update");
    expect(r.code).toBe(5);
    expect(r.err).toContain(".claude/skills/canon-b/SKILL.md");
    expect(existsSync(join(root, "..", `${root.split("/").pop()}.worktrees`))).toBe(false);
  });

  test("BR-2087: init merges the session hook into existing settings and keeps every other key", () => {
    const src = dir({ "canon-a/SKILL.md": "a\n" });
    const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root, "init", "-q");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "init", "--floor", "true").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0]!.command)).toEqual(["echo hi", "canon brief"]);
    canon(root, { CANON_SKILLS_SOURCE: src }, "install");
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).hooks.SessionStart.length).toBe(2); // added once
    writeFileSync(join(root, ".claude/settings.json"), "{ not json");
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(2);
  });

  test("BR-2087: a settings.json or .claude that is a symlink, even a dangling one, is refused and nothing is written through it", () => {
    const src = dir({ "canon-a/SKILL.md": "a\n" });
    const outside = mkdtempSync(join(tmpdir(), "canon-outside-"));
    const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root, "init", "-q");
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(outside, "settings.json"), join(root, ".claude/settings.json")); // target does not exist yet
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(2);
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
    const root2 = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root2, "init", "-q");
    symlinkSync(outside, join(root2, ".claude"));
    expect(canon(root2, { CANON_SKILLS_SOURCE: src }, "install", "--force").code).toBe(2);
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });

  test("BR-2089: a skill edited here while canon kept its version is not out of date, is kept by install and update, and is overwritten only with --force", () => {
    const { src, root, env } = project();
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    git(root, "commit", "-qam", "local edit");
    expect(canon(root, env, "update", "--check").code).toBe(0);
    expect(canon(root, env, "brief").out).not.toContain("out of date");
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    const r = canon(root, env, "update");
    expect(r.code).toBe(0);
    expect(git(root, "show", "main:.claude/skills/canon-a/SKILL.md")).toBe("a v2");
    expect(git(root, "show", "main:.claude/skills/canon-b/SKILL.md")).toBe("b edited here");
    expect(canon(root, env, "install").out).toContain("kept skill canon-b/SKILL.md");
    canon(root, env, "install", "--force");
    expect(readFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "utf8")).toBe("b v1\n");
  });
});
