import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installSkills, MANIFEST, skillsSource } from "./install.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-skills-"));
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

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-skills-repo-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  return root;
}

const source = () => dir({ "canon-a/SKILL.md": "a v1\n", "canon-a/references/x.md": "x v1\n", "canon-b/SKILL.md": "b v1\n", "user-own/SKILL.md": "not canon's\n" });

describe("project-level skills", () => {
  test("BR-2080: canon init installs canon's skills into the project's .claude/skills with a manifest; nothing goes to the user's home", () => {
    const src = source();
    const root = gitRepo();
    const home = mkdtempSync(join(tmpdir(), "canon-skills-home-"));
    const r = canon(root, { CANON_SKILLS_SOURCE: src, HOME: home }, "init", "--floor", "true");
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v1\n");
    expect(readFileSync(join(root, ".claude/skills/canon-a/references/x.md"), "utf8")).toBe("x v1\n");
    expect(existsSync(join(root, ".claude/skills/user-own"))).toBe(false); // only canon-* skills
    expect(Object.keys(JSON.parse(readFileSync(join(root, ".claude/skills", MANIFEST), "utf8")).files).sort()).toEqual(["canon-a/SKILL.md", "canon-a/references/x.md", "canon-b/SKILL.md"]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").out).toContain("canon project files: up to date");
  });

  test("BR-2080: canon init meets an edited skill copy the way skills install does, and writes nothing", () => {
    const src = source();
    const root = gitRepo();
    expect(installSkills(root, src, false).ok).toBe(true);
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n");
    const r = canon(root, { CANON_SKILLS_SOURCE: src }, "init", "--floor", "true");
    expect(r.code).toBe(5);
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  test("BR-2080: in canon's own repository the source is the target, so installing changes nothing", () => {
    const repo = dir({ ".claude/skills/canon-a/SKILL.md": "a\n" });
    const r = installSkills(repo, join(repo, ".claude/skills"), false);
    expect(r.ok && r.value).toEqual({ written: [], unchanged: [], removed: [], kept: [] });
    expect(existsSync(join(repo, ".claude/skills", MANIFEST))).toBe(false);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const cli = canon(repo, { CANON_SKILLS_SOURCE: join(repo, ".claude/skills") }, "install");
    expect(cli.code).toBe(0);
    expect(cli.out).not.toContain("skill canon-"); // the skills are the source here; only the session hook is added (BR-2087)
  });

  test("BR-2081: an unedited file follows canon's new version and a dropped one is removed; an edited one refuses the whole install until --force", () => {
    const src = source();
    const root = gitRepo();
    expect(installSkills(root, src, false).ok).toBe(true);
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    Bun.spawnSync(["rm", join(src, "canon-a/references/x.md")]);
    const upd = installSkills(root, src, false);
    expect(upd.ok && upd.value).toMatchObject({ written: ["canon-a/SKILL.md"], removed: ["canon-a/references/x.md"] });
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v2\n");
    expect(existsSync(join(root, ".claude/skills/canon-a/references/x.md"))).toBe(false);

    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v3\n");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n");
    const refused = installSkills(root, src, false);
    expect(!refused.ok && refused.error.code).toBe("conflict");
    expect(!refused.ok && refused.error.message).toContain(".claude/skills/canon-b/SKILL.md");
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v2\n"); // nothing half-updated
    expect(readFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "utf8")).toBe("b edited here\n");
    const r = canon(root, { CANON_SKILLS_SOURCE: src }, "install");
    expect(r.code).toBe(5);

    expect(installSkills(root, src, true).ok).toBe(true);
    expect(readFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "utf8")).toBe("b v2\n");
  });

  test("BR-2082: a skills source that cannot be found fails as an environment error before init writes anything", () => {
    expect(skillsSource({ CANON_SKILLS_SOURCE: "/nonexistent/skills" }).ok).toBe(false);
    const root = gitRepo();
    const r = canon(root, { CANON_SKILLS_SOURCE: mkdtempSync(join(tmpdir(), "canon-empty-")) }, "init", "--floor", "true");
    expect(r.code).toBe(4);
    expect(r.err).toContain("cannot find canon's skills");
    expect(existsSync(join(root, "canon"))).toBe(false);
  });
});

describe("installing stays inside the project", () => {
  test("BR-2083: a manifest naming a path outside canon-* skills is refused and nothing outside is deleted", () => {
    const src = source();
    const root = gitRepo();
    expect(installSkills(root, src, false).ok).toBe(true);
    const outside = join(root, "..", `${root.split("/").pop()}-victim.txt`);
    writeFileSync(outside, "keep me\n");
    const m = JSON.parse(readFileSync(join(root, ".claude/skills", MANIFEST), "utf8"));
    m.files[`../../../${outside.split("/").pop()}`] = require("node:crypto").createHash("sha256").update("keep me\n").digest("hex");
    writeFileSync(join(root, ".claude/skills", MANIFEST), JSON.stringify(m));
    const r = installSkills(root, src, true);
    expect(!r.ok && r.error.code).toBe("invalid");
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
  });

  test("BR-2083: a committed symlink inside .claude/skills is refused even with --force, so nothing is written through it", () => {
    const src = source();
    const root = gitRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "canon-skills-elsewhere-"));
    writeFileSync(join(elsewhere, "SKILL.md"), "someone else's file\n");
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    Bun.spawnSync(["ln", "-s", elsewhere, join(root, ".claude/skills/canon-a")]);
    const r = installSkills(root, src, true);
    expect(!r.ok && r.error.message).toContain("symbolic link");
    expect(readFileSync(join(elsewhere, "SKILL.md"), "utf8")).toBe("someone else's file\n");
  });
});
