import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRIEF_COMMAND, RECORD_COMMAND, SNAPSHOT_COMMAND } from "./hook.ts";
import { CoordDb } from "../../work/db.ts";
import { enqueue, tryTurn } from "../../work/land/queue/queue.ts";

/** The PreToolUse entry canon installs (BR-2185); a project with canon's current settings has it. */
const SNAPSHOT_ENTRY = { matcher: "Bash", hooks: [{ type: "command", command: SNAPSHOT_COMMAND }] };
/** The PostToolUse entry canon installs (BR-2274); a project with canon's current settings has it. */
const RECORD_ENTRY = { matcher: "AskUserQuestion", hooks: [{ type: "command", command: RECORD_COMMAND }] };
/** The worktree setting canon installs (BR-2264); a project with canon's current settings has it. */
const WORKTREE = { baseRef: "head" };

const MAIN = join(import.meta.dir, "..", "main.ts");

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

/** Commits the index onto main past canon's guard, as a fixture standing in for a landed change (BR-2123). */
function commitOnMain(root: string, message: string) {
  const c = git(root, "commit-tree", git(root, "write-tree"), "-p", "HEAD", "-m", message);
  Bun.spawnSync(["git", "update-ref", "refs/heads/main", c], { cwd: root, env: { ...process.env, CANON_LAND_MAIN: c } });
}

/** A canon project initialised from a fixture skills source and committed on main. */
function project() {
  const src = dir({ "canon-a/SKILL.md": "a v1\n", "canon-b/SKILL.md": "b v1\n" });
  const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(root, ...args);
  const env = { CANON_SKILLS_SOURCE: src };
  expect(canon(root, env, "init", "--floor", "true").code).toBe(0);
  writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\n'); // the updates land skill changes without a reviewer, on purpose (BR-2074)
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

  test("BR-2084: --check only reads: it does not create the coordination database", () => {
    const { root, env } = project();
    expect(existsSync(join(root, ".git/canon/state.db"))).toBe(false);
    expect(canon(root, env, "update", "--check").code).toBe(0);
    expect(existsSync(join(root, ".git/canon"))).toBe(false);
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

  test("BR-2085 BR-2195: when the skills source is missing or the manifest is broken, brief says it cannot check, and why", () => {
    const { root, env } = project();
    const missing = canon(root, { CANON_SKILLS_SOURCE: join(root, "no-such-skills") }, "brief");
    expect(missing.out.split("\n").filter((l) => l.includes("cannot check"))).toEqual([expect.stringContaining("canon project files: cannot check for updates (cannot find canon's skills")]);
    writeFileSync(join(root, ".claude/skills/.canon-skills.json"), "{ broken");
    expect(canon(root, env, "brief").out).toContain("canon project files: cannot check for updates (.claude/skills/.canon-skills.json is not valid JSON");
  });

  test("BR-2196: update writes the change's title, sections and commit message itself", () => {
    const { src, root, env } = project();
    writeFileSync(join(src, "canon-a/SKILL.md"), "a v2\n");
    writeFileSync(join(root, ".claude/settings.json"), "{}\n");
    git(root, "add", "-A");
    commitOnMain(root, "no session hook");
    const version = canon(root, env, "update", "--check").out.match(/version (\w+)/)![1];
    const r = canon(root, env, "update");
    expect(r.code).toBe(0);
    const change = r.out.match(/in (C-\d+), landed/)![1]!;
    expect(git(root, "log", "--format=%s", "main")).toContain(`Update canon project files to ${version} (${change})`);
    const file = git(root, "ls-tree", "--name-only", "main", "canon/changes/").split("\n").find((f) => f.includes(change))!;
    const text = git(root, "show", `main:${file}`);
    expect(text).toContain(`title: 更新 canon 装进项目的文件到版本 ${version}`);
    expect(text).toContain("## 为什么\n\n项目里 canon 装的文件（skill、会话开始时的 hook）落后于当前的 canon，按负责人的要求更新。");
    expect(text).toContain("## 要改什么\n\n- skill canon-a/SKILL.md\n- hook: canon brief at session start (.claude/settings.json)\n- hook: canon snapshot take before each Bash call (.claude/settings.json)\n- hook: canon human record after each answer to the question tool (.claude/settings.json)\n- setting: worktree.baseRef \"head\", so subagent worktrees start from local HEAD (.claude/settings.json)\n\n## 教训\n\n无。\n\n## 任务\n\n- [x] 由 `canon update` 安装并合入");
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

  test("BR-2086 BR-2022: an update whose landing is refused exits 1 and keeps its change and worktree; one still queued at the timeout exits 75", () => {
    const refused = project();
    writeFileSync(join(refused.root, "canon/config.yaml"), 'floor: "false"\ntests: []\n');
    git(refused.root, "add", "-A");
    commitOnMain(refused.root, "a floor that fails");
    writeFileSync(join(refused.src, "canon-a/SKILL.md"), "a v2\n");
    const r = canon(refused.root, refused.env, "update");
    expect([r.code, r.err]).toEqual([1, expect.stringMatching(/the update C-\d+ did not land: floor/)]);
    const change = r.err.match(/C-\d+/)![0];
    expect(git(refused.root, "branch", "--list", `change/${change}`)).toContain(`change/${change}`);
    expect(existsSync(join(refused.root, "..", `${refused.root.split("/").pop()}.worktrees`, change))).toBe(true);

    const queued = project();
    writeFileSync(join(queued.root, "canon/config.yaml"), 'floor: "true"\ntests: []\nland_timeout_minutes: 0.001\n');
    git(queued.root, "add", "-A");
    commitOnMain(queued.root, "a short queue wait");
    const db = CoordDb.open(join(queued.root, ".git/canon/state.db"), queued.root);
    if (!db.ok) throw new Error(db.error.message);
    expect(tryTurn(db.value, enqueue(db.value, "/elsewhere", "C-99", "agent:b")).mine).toBe(true); // someone else is landing
    writeFileSync(join(queued.src, "canon-a/SKILL.md"), "a v2\n");
    const t = canon(queued.root, queued.env, "update");
    expect([t.code, t.err]).toEqual([75, expect.stringContaining("landing(s) ahead; run `canon work land --finish`")]);
  });

  test("BR-2086: an update that would overwrite a file edited here is refused before any change is opened", () => {
    const { src, root, env } = project();
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    git(root, "add", "-A");
    commitOnMain(root, "local edit");
    writeFileSync(join(src, "canon-b/SKILL.md"), "b v2\n");
    const r = canon(root, env, "update");
    expect(r.code).toBe(5);
    expect(r.err).toContain(".claude/skills/canon-b/SKILL.md");
    expect(existsSync(join(root, "..", `${root.split("/").pop()}.worktrees`))).toBe(false);
  });

  test("BR-2086 BR-2083: an update that would write through a symlink, or a manifest naming a path outside canon-*, is refused with 2 before any change is opened", () => {
    const worktrees = (root: string) => join(root, "..", `${root.split("/").pop()}.worktrees`);
    const branches = (root: string) => git(root, "branch", "--list", "change/*");
    const linked = project();
    const ext = dir({ "SKILL.md": "a v1\n" });
    rmSync(join(linked.root, ".claude/skills/canon-a"), { recursive: true });
    symlinkSync(ext, join(linked.root, ".claude/skills/canon-a"));
    git(linked.root, "add", "-A");
    commitOnMain(linked.root, "link");
    writeFileSync(join(linked.src, "canon-b/SKILL.md"), "b v2\n");
    const r = canon(linked.root, linked.env, "update");
    expect([r.code, r.err]).toEqual([2, expect.stringContaining(".claude/skills/canon-a is a symbolic link")]);
    expect([branches(linked.root), existsSync(worktrees(linked.root))]).toEqual(["", false]);

    const listed = project();
    const manifest = join(listed.root, ".claude/skills/.canon-skills.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.files["../outside.txt"] = "0".repeat(64);
    writeFileSync(manifest, JSON.stringify(m));
    writeFileSync(join(listed.src, "canon-b/SKILL.md"), "b v2\n");
    const l = canon(listed.root, listed.env, "update");
    expect([l.code, l.err]).toEqual([2, expect.stringContaining("lists paths canon never writes")]);
    expect([branches(listed.root), existsSync(worktrees(listed.root))]).toEqual(["", false]);
  });

  test("BR-2087 BR-2080: an invalid or symlinked settings.json refuses install and init with 2 before any skill is written", () => {
    const src = dir({ "canon-a/SKILL.md": "a\n" });
    for (const command of ["install", "init"]) {
      const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
      git(root, "init", "-q");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude/settings.json"), "{ not json");
      const r = canon(root, { CANON_SKILLS_SOURCE: src }, command, "--floor", "true");
      expect([command, r.code]).toEqual([command, 2]);
      expect(readdirSync(join(root, ".claude"))).toEqual(["settings.json"]);
      expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe("{ not json");
      expect(existsSync(join(root, "canon"))).toBe(false);
    }
    const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root, "init", "-q");
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(mkdtempSync(join(tmpdir(), "canon-outside-")), "settings.json"), join(root, ".claude/settings.json"));
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(2);
    expect(readdirSync(join(root, ".claude"))).toEqual(["settings.json"]);
  });

  test("BR-2124: someone else's git hook is reported before an invalid settings.json: install and update exit 5", () => {
    const { root, env } = project();
    writeFileSync(join(root, ".git/hooks/reference-transaction"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, ".claude/settings.json"), "{ not json");
    for (const command of ["install", "update"]) {
      const r = canon(root, env, command);
      expect([command, r.code, r.err]).toEqual([command, 5, expect.stringContaining("was not written by canon")]);
    }
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
    expect(s.hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0]!.command)).toEqual(["echo hi", BRIEF_COMMAND]);
    expect(BRIEF_COMMAND.startsWith("canon brief || echo ")).toBe(true);
    canon(root, { CANON_SKILLS_SOURCE: src }, "install");
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).hooks.SessionStart.length).toBe(2); // added once
    writeFileSync(join(root, ".claude/settings.json"), "{ not json");
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(2);
  });

  test("BR-2087 BR-2084: the old `canon brief` hook is reported once and rewritten in place, never added a second time", () => {
    const { root, env } = project();
    const old = { permissions: { allow: [] }, hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "canon brief" }] }, { hooks: [{ type: "command", command: "echo hi" }] }] } };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(old));
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hook: canon brief at session start, older form");
    expect(canon(root, env, "install").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s).toEqual({ ...old, hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: BRIEF_COMMAND }] }, old.hooks.SessionStart[1]], PreToolUse: [SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] }, worktree: WORKTREE });
    canon(root, env, "install");
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual(s);
    expect(canon(root, env, "update", "--check").code).toBe(0);
  });

  test("BR-2087: the hook command still tells the session about canon when canon is not on PATH or brief fails", () => {
    const empty = mkdtempSync(join(tmpdir(), "canon-no-path-"));
    const sh = (path: string) => Bun.spawnSync(["/bin/sh", "-c", BRIEF_COMMAND], { cwd: empty, stdout: "pipe", stderr: "pipe", env: { PATH: path } });
    const missing = sh(empty);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout.toString()).toContain("canon is not on PATH");
    expect(missing.stdout.toString()).toContain("do not edit the main branch directly");
    writeFileSync(join(empty, "canon"), "#!/bin/sh\necho 'canon brief failed: broken config'\nexit 2\n", { mode: 0o755 });
    const failing = sh(empty);
    expect(failing.exitCode).toBe(0);
    const out = failing.stdout.toString();
    expect(out.indexOf("canon brief failed: broken config")).toBe(0);
    expect(out).toContain("canon is not on PATH");
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

  test("BR-2185: init adds the snapshot hook before Bash calls next to the user's own PreToolUse entries, once", () => {
    const src = dir({ "canon-a/SKILL.md": "a\n" });
    const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root, "init", "-q");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const theirs = { matcher: "Edit", hooks: [{ type: "command", command: "echo edit" }] };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [theirs] } }));
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "init", "--floor", "true").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toEqual([theirs, SNAPSHOT_ENTRY]);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(BRIEF_COMMAND);
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual(s);
  });

  test("BR-2185 BR-2084: a project without the snapshot hook is out of date until install adds it", () => {
    const { root, env } = project();
    expect(canon(root, env, "update", "--check").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    delete s.hooks.PreToolUse;
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(s));
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hook: canon snapshot take before each Bash call (.claude/settings.json)");
    expect(canon(root, env, "install").code).toBe(0);
    expect(canon(root, env, "update", "--check").code).toBe(0);
  });

  const settingsOf = (root: string) => JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  const BASE_REF_LINE = 'setting: worktree.baseRef "head", so subagent worktrees start from local HEAD (.claude/settings.json)';

  test("BR-2264 BR-2087: init sets worktree.baseRef to head next to the session hook; --check is up to date and install leaves the file as it is", () => {
    const { root, env } = project();
    expect(settingsOf(root).worktree).toEqual({ baseRef: "head" });
    expect(canon(root, env, "update", "--check").code).toBe(0);
    const before = readFileSync(join(root, ".claude/settings.json"), "utf8");
    expect(canon(root, env, "install").code).toBe(0);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(before);
  });

  test("BR-2264 BR-2084: a missing or other baseRef is out of date; install sets head and keeps the rest of worktree", () => {
    const { root, env } = project();
    for (const worktree of [undefined, { baseRef: "fresh" }, { symlinkDirectories: ["node_modules"] }]) {
      const s = settingsOf(root);
      if (worktree === undefined) delete s.worktree;
      else s.worktree = worktree;
      writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(s));
      const r = canon(root, env, "update", "--check");
      expect([r.code, r.out]).toEqual([1, expect.stringContaining(BASE_REF_LINE)]);
      expect(canon(root, env, "install").code).toBe(0);
      expect(settingsOf(root).worktree).toEqual({ ...(worktree ?? {}), baseRef: "head" });
      expect(settingsOf(root).hooks).toEqual(s.hooks);
      expect(canon(root, env, "update", "--check").code).toBe(0);
    }
  });

  test("BR-2264 BR-2084: a worktree setting that is not an object is refused with 2 and the file is left as it was", () => {
    const { root, env } = project();
    const s = { ...settingsOf(root), worktree: "head" };
    const text = JSON.stringify(s);
    writeFileSync(join(root, ".claude/settings.json"), text);
    for (const args of [["install"], ["update", "--check"]]) {
      const r = canon(root, env, ...args);
      expect([r.code, r.err]).toEqual([2, expect.stringContaining("`worktree` in .claude/settings.json must be a JSON object")]);
    }
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(text);
  });

  test("BR-2274 BR-2087: init adds the record hook after the question tool next to the user's own PostToolUse entries, once", () => {
    const src = dir({ "canon-a/SKILL.md": "a\n" });
    const root = mkdtempSync(join(tmpdir(), "canon-update-repo-"));
    git(root, "init", "-q");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const theirs = { matcher: "Write", hooks: [{ type: "command", command: "echo wrote" }] };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PostToolUse: [theirs] } }));
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "init", "--floor", "true").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s.hooks.PostToolUse).toEqual([theirs, RECORD_ENTRY]);
    expect(canon(root, { CANON_SKILLS_SOURCE: src }, "install").code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual(s);
  });

  test("BR-2274 BR-2084: a project without the record hook is out of date until install adds it", () => {
    const { root, env } = project();
    expect(canon(root, env, "update", "--check").code).toBe(0);
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    delete s.hooks.PostToolUse;
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(s));
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hook: canon human record after each answer to the question tool (.claude/settings.json)");
    expect(canon(root, env, "install").code).toBe(0);
    expect(canon(root, env, "update", "--check").code).toBe(0);
  });

  test("BR-2274: the record hook command never blocks: without canon on PATH it exits 0 with a systemMessage for the user", () => {
    const empty = mkdtempSync(join(tmpdir(), "canon-no-path-"));
    const r = Bun.spawnSync(["/bin/sh", "-c", RECORD_COMMAND], { cwd: empty, stdout: "pipe", stderr: "pipe", env: { PATH: empty } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).systemMessage).toContain("this answer was not recorded");
  });

  test("BR-2185: the snapshot hook command never blocks: without canon on PATH it exits 0 with a systemMessage for the user", () => {
    const empty = mkdtempSync(join(tmpdir(), "canon-no-path-"));
    const r = Bun.spawnSync(["/bin/sh", "-c", SNAPSHOT_COMMAND], { cwd: empty, stdout: "pipe", stderr: "pipe", env: { PATH: empty } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).systemMessage).toContain("uncommitted work was not snapshotted");
  });

  test("BR-2130 BR-2084: the withdrawn pre-bash hook and actor allow rule are out of date and removed by install, leaving the file as it was before them", () => {
    const { root, env } = project();
    const before = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: BRIEF_COMMAND }] }], PreToolUse: [SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] }, model: "x", worktree: WORKTREE };
    const withdrawn = {
      ...before,
      hooks: { ...before.hooks, PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "canon hook pre-bash 2>/dev/null || true" }] }, SNAPSHOT_ENTRY] },
      permissions: { allow: ["Bash(export CANON_ACTOR='agent:*')"] },
    };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(withdrawn));
    const r = canon(root, env, "update", "--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("hook: canon hook pre-bash before each Bash call, withdrawn by canon; install or update removes it (.claude/settings.json)");
    expect(r.out).toContain("permission: Bash(export CANON_ACTOR='agent:*'), withdrawn by canon; install or update removes it (.claude/settings.json)");
    expect(r.out).not.toContain("canon brief at session start");
    expect(canon(root, env, "install").code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual(before);
    expect(canon(root, env, "update", "--check").code).toBe(0);
  });

  test("BR-2130: removing a withdrawn allow rule leaves a PreToolUse list that was already empty", () => {
    const { root, env } = project();
    const start = [{ hooks: [{ type: "command", command: BRIEF_COMMAND }] }];
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: start, PreToolUse: [] }, permissions: { allow: ["Bash(ls)", "Bash(export CANON_ACTOR='agent:*')"] } }));
    expect(canon(root, env, "install").code).toBe(0);
    // The empty list is kept by the removal (BR-2130); the same write then adds canon's snapshot entry to it (BR-2185).
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual({ hooks: { SessionStart: start, PreToolUse: [SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] }, permissions: { allow: ["Bash(ls)"] }, worktree: WORKTREE });
  });

  test("BR-2130: only canon's two withdrawn entries go; the user's hooks and allow rules, and containers that were already empty, stay", () => {
    const { root, env } = project();
    const mine = { type: "command", command: "echo pre" };
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: BRIEF_COMMAND }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [mine, { type: "command", command: "canon hook pre-bash" }] }, { matcher: "Read", hooks: [mine] }, SNAPSHOT_ENTRY],
      },
      permissions: { allow: ["Bash(ls)", "Bash(export CANON_ACTOR='agent:*')", "Bash(export CANON_ACTOR='agent:x')"], deny: [] },
    };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(settings));
    expect(canon(root, env, "install").code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual({
      hooks: { SessionStart: settings.hooks.SessionStart, PreToolUse: [{ matcher: "Bash", hooks: [mine] }, { matcher: "Read", hooks: [mine] }, SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] },
      permissions: { allow: ["Bash(ls)", "Bash(export CANON_ACTOR='agent:x')"], deny: [] },
      worktree: WORKTREE,
    });
    const empty = { hooks: { SessionStart: settings.hooks.SessionStart, PreToolUse: [SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] }, permissions: { allow: [] }, worktree: WORKTREE };
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(empty));
    expect(canon(root, env, "update", "--check").code).toBe(0);
    expect(canon(root, env, "install").code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual(empty);
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: settings.hooks.SessionStart, PreToolUse: [SNAPSHOT_ENTRY], PostToolUse: [RECORD_ENTRY] }, permissions: "all", worktree: WORKTREE }));
    expect(canon(root, env, "update", "--check").code).toBe(0);
  });

  test("BR-2089: a skill edited here while canon kept its version is not out of date, is kept by install and update, and is overwritten only with --force", () => {
    const { src, root, env } = project();
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "b edited here\n");
    git(root, "add", "-A");
    commitOnMain(root, "local edit");
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
