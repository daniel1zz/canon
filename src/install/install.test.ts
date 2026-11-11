import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installSkills, MANIFEST, skillsSource, versionOf } from "./install.ts";
import { BRIEF_COMMAND } from "./hook.ts";
import { BUILTIN_TYPES, idsIn } from "../knowledge/documents/types.ts";
import { stripCode } from "../knowledge/documents/model.ts";
import { WORKFLOW_GUIDE } from "../invocation/guide.ts";

// reason: these tests spawn the canon CLI, and one compiles it; at load a spawn alone can take seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");

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
  test("BR-2080 BR-2412: a worktree of canon's own repository, with the published dist/skills as the source, gets no skill written", () => {
    const repo = dir({ ".claude/skills/canon-a/SKILL.md": "a newer on main\n", "dist/skills-abc1234/canon-a/SKILL.md": "a as published\n" });
    symlinkSync("skills-abc1234", join(repo, "dist/skills"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", ".claude"], ["commit", "-qm", "skills"], ["worktree", "add", "-q", "../" + repo.split("/").pop() + "-wt", "-b", "wt"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
    }
    const wt = `${repo}-wt`;
    const r = installSkills(wt, join(repo, "dist/skills"), false);
    expect(r.ok && r.value).toEqual({ written: [], unchanged: [], removed: [], kept: [] });
    expect(readFileSync(join(wt, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a newer on main\n");
    // another repository with the same published source is installed as usual
    const other = gitRepo();
    const o = installSkills(other, join(repo, "dist/skills"), false);
    expect(o.ok && o.value.written).toEqual(["canon-a/SKILL.md"]);
  });

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
    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command))).toEqual([BRIEF_COMMAND]);
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

describe("where the skills come from and their version", () => {
  test("BR-2082 BR-2412: the compiled dist/canon installs from the dist/skills published beside it, else from the .claude/skills of the repository that holds it", () => {
    const repo = dir({ ".claude/skills/canon-z/SKILL.md": "z from the repository holding dist/canon\n" });
    const built = Bun.spawnSync(["bun", "build", "--compile", MAIN, "--outfile", join(repo, "dist/canon")], { stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    const root = gitRepo();
    const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:test" };
    delete env["CANON_SKILLS_SOURCE"];
    const r = Bun.spawnSync([join(repo, "dist/canon"), "install"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(join(root, ".claude/skills/canon-z/SKILL.md"), "utf8")).toBe("z from the repository holding dist/canon\n");
    // a release published beside the binary wins over the repository's newer, unchecked skills (BR-2412)
    mkdirSync(join(repo, "dist/skills-abc1234/canon-z"), { recursive: true });
    writeFileSync(join(repo, "dist/skills-abc1234/canon-z/SKILL.md"), "z as published\n");
    symlinkSync("skills-abc1234", join(repo, "dist/skills"));
    const again = Bun.spawnSync([join(repo, "dist/canon"), "install"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    expect([again.exitCode, again.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(join(root, ".claude/skills/canon-z/SKILL.md"), "utf8")).toBe("z as published\n");
  });

  test("BR-2082: a dist/skills that is there but holds no canon skill, such as a link to a removed release, fails as an environment error instead of falling back to the repository", () => {
    const repo = dir({ ".claude/skills/canon-z/SKILL.md": "z unreviewed\n", "dist/canon": "binary\n" });
    const nowhere = join(mkdtempSync(join(tmpdir(), "canon-module-")), "a", "b");
    expect(skillsSource({}, nowhere, join(repo, "dist/canon"))).toEqual({ ok: true, value: join(realpathSync(repo), ".claude", "skills") });
    symlinkSync("skills-gone", join(repo, "dist/skills"));
    const broken = skillsSource({}, nowhere, join(repo, "dist/canon"));
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error.message).toContain("dist/skills holds no canon-* skill");
  });

  test("BR-2082: the npm package's bundled dist/canon.js installs from the .claude/skills inside the package", () => {
    const pkg = dir({ ".claude/skills/canon-z/SKILL.md": "z from the npm package\n" });
    const built = Bun.spawnSync(["bun", "build", MAIN, "--target", "bun", "--outfile", join(pkg, "dist/canon.js")], { stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    const root = gitRepo();
    const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:test" };
    delete env["CANON_SKILLS_SOURCE"];
    const r = Bun.spawnSync(["bun", join(pkg, "dist/canon.js"), "install"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(join(root, ".claude/skills/canon-z/SKILL.md"), "utf8")).toBe("z from the npm package\n");
  });

  test("BR-2084: the version is computed from the skill files' content: the same files give the same version, any change gives another", () => {
    expect(versionOf({ "canon-a/SKILL.md": "h1" })).toBe(versionOf({ "canon-a/SKILL.md": "h1" }));
    expect(versionOf({ "canon-a/SKILL.md": "h2" })).not.toBe(versionOf({ "canon-a/SKILL.md": "h1" }));
    const src = source();
    const root = gitRepo();
    const version = (out: string) => out.match(/version (\w+)/)![1];
    const before = version(canon(root, { CANON_SKILLS_SOURCE: src }, "init", "--floor", "true").out + canon(root, { CANON_SKILLS_SOURCE: src }, "update", "--check").out);
    writeFileSync(join(src, "canon-a/references/x.md"), "x v2\n");
    const after = version(canon(root, { CANON_SKILLS_SOURCE: src }, "update", "--check").out);
    expect(after).not.toBe(before);
    writeFileSync(join(src, "canon-a/references/x.md"), "x v1\n");
    expect(version(canon(root, { CANON_SKILLS_SOURCE: src }, "update", "--check").out)).toBe(before);
  });

  test("BR-2195: a manifest that is not valid JSON refuses install, init and update --check with 2 and writes nothing; brief says it cannot check", () => {
    const src = source();
    const root = gitRepo();
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(0);
    const manifest = join(root, ".claude/skills", MANIFEST);
    writeFileSync(manifest, "{ broken");
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    for (const args of [["install"], ["init", "--floor", "true"], ["update", "--check"]]) {
      const r = canon(root, { CANON_SKILLS_SOURCE: src }, ...args);
      expect([args[0], r.code, r.err]).toEqual([args[0], 2, expect.stringContaining(".claude/skills/.canon-skills.json is not valid JSON; fix or delete it")]);
    }
    expect(readFileSync(manifest, "utf8")).toBe("{ broken");
    expect(readFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "utf8")).toBe("a v1\n");
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
  test("BR-2083: through the CLI, a manifest path outside canon-* and a symlink exit 2, the symlink checked before an edited file, and nothing is written", () => {
    const src = source();
    const root = gitRepo();
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(0);
    const manifest = join(root, ".claude/skills", MANIFEST);
    const good = readFileSync(manifest, "utf8");
    const m = JSON.parse(good);
    m.files["../../../victim.txt"] = "0".repeat(64);
    writeFileSync(manifest, JSON.stringify(m));
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install", "--force").code).toBe(2);
    writeFileSync(manifest, good);

    const elsewhere = mkdtempSync(join(tmpdir(), "canon-skills-elsewhere-"));
    writeFileSync(join(elsewhere, "SKILL.md"), "someone else's file\n");
    Bun.spawnSync(["rm", "-r", join(root, ".claude/skills/canon-a")]);
    Bun.spawnSync(["ln", "-s", elsewhere, join(root, ".claude/skills/canon-a")]);
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n"); // alone this would be a BR-2081 conflict, exit 5
    const r = canon(root, { CANON_SKILLS_SOURCE: src }, "install");
    expect([r.code, r.err]).toEqual([2, expect.stringContaining("symbolic link")]);
    expect(readFileSync(join(elsewhere, "SKILL.md"), "utf8")).toBe("someone else's file\n");
    expect(readFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "utf8")).toBe("b edited here\n");
    expect(readFileSync(manifest, "utf8")).toBe(good);
  });
});

describe("text canon ships into other projects", () => {
  test("BR-2096: shipped skills and the workflow guide name no canon document ids outside code", () => {
    const skills = join(import.meta.dir, "..", "..", ".claude", "skills");
    const offending: string[] = [];
    for (const rel of new Bun.Glob("canon-*/**/*").scanSync({ cwd: skills })) {
      for (const id of idsIn(BUILTIN_TYPES, stripCode(readFileSync(join(skills, rel), "utf8")))) offending.push(`${rel}: ${id}`);
    }
    for (const id of idsIn(BUILTIN_TYPES, stripCode(WORKFLOW_GUIDE))) offending.push(`guide: ${id}`);
    expect(offending).toEqual([]);
    const sample = ["一条规则一个结果（", "D", "-5）"].join("");
    expect(idsIn(BUILTIN_TYPES, stripCode(sample)).size).toBe(1); // the scan does catch a bare id
  });
});
