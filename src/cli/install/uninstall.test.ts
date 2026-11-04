import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planUnhook, RECORD_COMMAND, SNAPSHOT_COMMAND } from "./hook.ts";

// reason: every test drives the canon CLI through spawned processes, a landing included (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "main.ts");

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-uninstall-"));
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

const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const git = (cwd: string, ...args: string[]) => run(cwd, ...args).stdout.toString().trim();
const onMain = (root: string, path: string) => run(root, "cat-file", "-e", `main:${path}`).exitCode === 0;
const guard = (root: string) => join(root, ".git", "hooks", "reference-transaction");

/** A canon project with a bare remote, committed and pushed; `config` is canon/config.yaml. */
function project(config = 'floor: "true"\ntests: []\nremote: origin\n') {
  const src = dir({ "canon-a/SKILL.md": "a v1\n", "canon-b/SKILL.md": "b v1\n" });
  const remote = mkdtempSync(join(tmpdir(), "canon-uninstall-remote-"));
  run(remote, "init", "-q", "--bare", "-b", "main");
  const root = mkdtempSync(join(tmpdir(), "canon-uninstall-repo-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", remote]]) git(root, ...args);
  const env = { CANON_SKILLS_SOURCE: src };
  expect(canon(root, env, "init", "--floor", "true").code).toBe(0);
  writeFileSync(join(root, "canon/config.yaml"), config);
  mkdirSync(join(root, "canon/rules"), { recursive: true });
  writeFileSync(join(root, "canon/notes-kept.md"), "kept\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  git(root, "push", "-q", "origin", "main");
  return { root, env, remote };
}

describe("canon uninstall", () => {
  test("BR-2278: lands one change removing canon's skills, its settings entries and canon/config.yaml; the rest of canon/ and worktree.baseRef stay", () => {
    const { root, env, remote } = project();
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(0);
    expect(onMain(root, "canon/config.yaml")).toBe(false);
    expect(onMain(root, ".claude/skills")).toBe(false);
    expect(onMain(root, "canon/notes-kept.md")).toBe(true);
    expect(JSON.parse(git(root, "show", "main:.claude/settings.json"))).toEqual({ worktree: { baseRef: "head" } });
    expect(git(root, "log", "--format=%s", "main")).toContain("Uninstall canon (C-1)");
    expect(r.out).toContain('kept worktree.baseRef "head"');
    // the landing's own push cannot read the remote any more; uninstall pushes it
    expect(git(remote, "rev-parse", "main")).toBe(git(root, "rev-parse", "main"));
  });

  test("BR-2278: a landing that is refused leaves canon on main and everything outside the tree in place, exit 1", () => {
    const { root, env } = project('floor: "false"\ntests: []\n');
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not land (floor)");
    expect(onMain(root, "canon/config.yaml")).toBe(true);
    expect(existsSync(guard(root))).toBe(true);
    expect(existsSync(join(root, ".git", "canon"))).toBe(true);
  });

  test("BR-2277, BR-2022: a change still in flight refuses with exit 5 and lists it, changing nothing", () => {
    const { root, env } = project();
    expect(canon(root, env, "work", "start", "--title", "wip").code).toBe(0);
    const head = git(root, "rev-parse", "main");
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(5);
    expect(r.err).toContain("C-1: claimed");
    expect(git(root, "rev-parse", "main")).toBe(head);
    expect(existsSync(join(root, ".claude/skills/canon-a/SKILL.md"))).toBe(true);
    expect(existsSync(guard(root))).toBe(true);
  });

  test("BR-2277: an unlanded change branch without a worktree counts as in flight; a landed one does not", () => {
    const { root, env } = project();
    git(root, "branch", "change/C-9", "main");
    git(root, "branch", "change/C-8", "main");
    const tree = git(root, "write-tree");
    const c = git(root, "commit-tree", tree, "-p", "change/C-9", "-m", "wip");
    git(root, "update-ref", "refs/heads/change/C-9", c);
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(5);
    expect(r.err).toContain("change/C-9: 1 commit(s) not on main");
    expect(r.err).not.toContain("change/C-8");
  });

  test("BR-2279: an edited canon skill file refuses with exit 5; --force deletes it; a file the project added stays", () => {
    const { root, env } = project();
    writeFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), "edited\n");
    writeFileSync(join(root, ".claude/skills/canon-b/mine.md"), "mine\n");
    git(root, "add", "-A");
    const c = git(root, "commit-tree", git(root, "write-tree"), "-p", "HEAD", "-m", "edit");
    Bun.spawnSync(["git", "update-ref", "refs/heads/main", c], { cwd: root, env: { ...process.env, CANON_LAND_MAIN: c } });
    const refused = canon(root, env, "uninstall");
    expect(refused.code).toBe(5);
    expect(refused.err).toContain(".claude/skills/canon-a/SKILL.md");
    expect(onMain(root, "canon/config.yaml")).toBe(true);
    expect(canon(root, env, "uninstall", "--force").code).toBe(0);
    expect(onMain(root, ".claude/skills/canon-a/SKILL.md")).toBe(false);
    expect(onMain(root, ".claude/skills/canon-b/mine.md")).toBe(true);
  });

  test("BR-2280: after the landing, the guard, coordination state, worktrees, branches and non-recovery refs are gone; main moves by plain git; a second run says not installed", () => {
    const { root, env } = project();
    git(root, "update-ref", "refs/canon/green", "main");
    expect(canon(root, env, "uninstall").code).toBe(0);
    expect(existsSync(guard(root))).toBe(false);
    expect(existsSync(join(root, ".git", "canon"))).toBe(false);
    expect(existsSync(`${root}.worktrees`)).toBe(false);
    expect(git(root, "for-each-ref", "refs/canon", "refs/heads/change")).toBe("");
    writeFileSync(join(root, "f"), "x\n");
    git(root, "add", "f");
    expect(run(root, "commit", "-qm", "plain").exitCode).toBe(0);
    const again = canon(root, env, "uninstall");
    expect(again.code).toBe(0);
    expect(again.out).toContain("canon is not installed here");
  });

  test("BR-2280: another clone that has not pulled the uninstall syncs to it and only cleans up locally", () => {
    const { root, env, remote } = project();
    const other = mkdtempSync(join(tmpdir(), "canon-uninstall-clone-"));
    run(other, "clone", "-q", remote, ".");
    expect(canon(other, env, "install").code).toBe(0);
    expect(canon(root, env, "uninstall").code).toBe(0);
    const r = canon(other, env, "uninstall");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Uninstall canon");
    expect(git(other, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
    expect(existsSync(guard(other))).toBe(false);
  });

  test("BR-2280: someone else's reference-transaction hook is left alone", () => {
    const { root, env } = project();
    expect(canon(root, env, "uninstall").code).toBe(0);
    writeFileSync(guard(root), "#!/bin/sh\n# lefthook\nexit 0\n", { mode: 0o755 });
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(0);
    expect(readFileSync(guard(root), "utf8")).toContain("lefthook");
  });

  test("BR-2281: recovery refs stay and are counted; --purge-recovery deletes them", () => {
    const { root, env } = project();
    git(root, "update-ref", "refs/canon/archive/C-3/1", "main");
    git(root, "update-ref", "refs/canon/snapshots/p/1", "main");
    git(root, "update-ref", "refs/canon/snapshots/p/2", "main");
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept 1 archive(s) under refs/canon/archive and 2 snapshot(s)");
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/canon").split("\n")).toHaveLength(3);
    const purged = canon(root, env, "uninstall", "--purge-recovery");
    expect(purged.out).toContain("deleted 3 recovery ref(s)");
    expect(git(root, "for-each-ref", "refs/canon")).toBe("");
  });

  test("BR-2282: --remove-knowledge removes canon/ from main in a commit of its own and pushes it", () => {
    const { root, env, remote } = project();
    const r = canon(root, env, "uninstall", "--remove-knowledge");
    expect(r.code).toBe(0);
    expect(onMain(root, "canon")).toBe(false);
    expect(git(root, "log", "-1", "--format=%s", "main")).toBe("Remove canon/ (canon uninstall --remove-knowledge)");
    expect(git(remote, "rev-parse", "main")).toBe(git(root, "rev-parse", "main"));
  });

  test("BR-2282: --remove-knowledge with the primary checkout on another branch refuses that step with exit 5 and leaves canon/", () => {
    const { root, env } = project();
    expect(canon(root, env, "uninstall").code).toBe(0);
    git(root, "checkout", "-q", "-b", "side");
    const r = canon(root, env, "uninstall", "--remove-knowledge");
    expect(r.code).toBe(5);
    expect(r.err).toContain("not on main");
    expect(onMain(root, "canon/notes-kept.md")).toBe(true);
  });

  test("BR-2283, BR-2022: while the landing's after_land commands run, the cleanup waits with exit 75; later it finishes", async () => {
    const { root, env } = project('floor: "true"\ntests: []\nhooks:\n  after_land:\n    - "sleep 4"\n');
    const r = canon(root, env, "uninstall");
    expect(r.code).toBe(75);
    expect(r.err).toContain("after_land commands are still running");
    expect(onMain(root, "canon/config.yaml")).toBe(false);
    expect(existsSync(guard(root))).toBe(true);
    await Bun.sleep(6000);
    expect(canon(root, env, "uninstall").code).toBe(0);
    expect(existsSync(guard(root))).toBe(false);
  });
});

describe("removing canon's settings entries", () => {
  const settings = (v: unknown) => dir({ ".claude/settings.json": JSON.stringify(v) });

  test("BR-2278: canon's entries go, the project's own stay, emptied lists and objects go, worktree.baseRef stays", () => {
    const root = settings({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "canon brief" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: SNAPSHOT_COMMAND }] }, { matcher: "Edit", hooks: [{ type: "command", command: "echo mine" }] }],
        PostToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: RECORD_COMMAND }, { type: "command", command: "echo also" }] }],
      },
      permissions: { allow: ["Bash(export CANON_ACTOR='agent:*')"] },
      worktree: { baseRef: "head" },
    });
    const p = planUnhook(root);
    expect(p.ok && p.value).toEqual({
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo mine" }] }], PostToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "echo also" }] }] },
      worktree: { baseRef: "head" },
    });
  });

  test("BR-2278: a file holding only canon's entries is to be deleted; one with none of them is left alone", () => {
    const only = planUnhook(settings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: SNAPSHOT_COMMAND }] }] } }));
    expect(only.ok && only.value).toBe(null);
    const none = planUnhook(settings({ hooks: { PreToolUse: [] } }));
    expect(none.ok && none.value).toBe(undefined);
  });
});
