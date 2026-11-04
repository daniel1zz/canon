import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHandoff } from "./handoffs.ts";
import { changeOnBranch } from "./inflight.ts";
import { project, sh, ws } from "../testkit.ts";

// reason: each case spawns the CLI several times (work start, stop, change list, brief); under load one spawn takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");
const id = (n: number) => ["C", n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function changeFile(dir: string, n: number, status = "open") {
  mkdirSync(join(dir, "canon/changes"), { recursive: true });
  writeFileSync(join(dir, `canon/changes/${id(n)}.md`), `---\nid: ${id(n)}\ntitle: Change ${n}\nstatus: ${status}\n---\n\n## 为什么\n\nx.\n\n## 要改什么\n\nx.\n\n## 任务\n\n- [ ] x\n`);
}

/** A project whose main has the not-started C-1, and C-2 made with --title, so it lives only on its branch. */
function withBranchOnly(): { root: string; wt: string; branch: string } {
  const root = project();
  changeFile(root, 1);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "C-1");
  const started = canon(root, "work", "start", "--title", "Only on branch");
  expect(started.code).toBe(0);
  return { root, wt: started.out.match(/cd (.+)/)![1]!.trim(), branch: `change/${id(2)}-only-on-branch` };
}

const rows = (out: string) => out.split("\n").filter(Boolean);
const ids = (out: string) => rows(out).map((l) => l.split(/\s+/)[0]);
const PICK = "with no task, take the first unclaimed one: ";

describe("changes that so far exist only on their branch", () => {
  test("BR-2291: a released, handed-off change only on its branch is listed first, marked, in change list, --json and brief", () => {
    const { root, wt, branch } = withBranchOnly();
    expect(canon(wt, "work", "stop", "--release", "--next", "land it").code).toBe(0);

    const list = canon(root, "change", "list");
    expect(list.code).toBe(0);
    expect(rows(list.out)).toEqual([
      `${id(2)}      open       Only on branch  (on branch ${branch}; handoff: land it)`,
      `${id(1)}      open       Change 1`,
    ]);
    const data = JSON.parse(canon(root, "change", "list", "--json").out) as { id: string; on_branch: string[]; handoff: { next: string; actor: string } | null; claimed: boolean }[];
    expect(data.map((c) => [c.id, c.on_branch, c.handoff?.next ?? null, c.claimed])).toEqual([
      [id(2), [branch], "land it", false],
      [id(1), [], null, false],
    ]);
    expect(data[0]!.handoff!.actor).toBe("agent:a");
    expect(canon(root, "brief").out).toContain(`${PICK}${id(2)} (on branch ${branch}, handoff), ${id(1)}\n`);

    // The worktree is gone, the branch stays: still listed, read from the branch.
    sh(root, "worktree", "remove", "--force", wt);
    expect(rows(canon(root, "change", "list").out)[0]).toBe(`${id(2)}      open       Only on branch  (on branch ${branch}; handoff: land it)`);
  });

  test("BR-2291: a claim that still binds is marked claimed; the backlog still comes first", () => {
    const { root, wt, branch } = withBranchOnly();
    expect(canon(wt, "work", "stop", "--next", "land it").code).toBe(0);
    expect(rows(canon(root, "change", "list").out)[0]).toBe(`${id(2)}      open       Only on branch  (on branch ${branch}; handoff: land it; claimed)`);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(2)} (on branch ${branch}, handoff, claimed), ${id(1)}\n`);

    writeFileSync(join(root, "canon/backlog.md"), `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n- ${id(1)}\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "backlog");
    expect(ids(canon(root, "change", "list").out)).toEqual([id(1), id(2)]);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(1)}, ${id(2)} (on branch ${branch}, handoff, claimed)\n`);
  });

  test("BR-2291: a branch-only change without a handoff is still listed, ahead of one not started", () => {
    const { root, branch } = withBranchOnly();
    ws(root).db.db.query("DELETE FROM claims").run(); // its session ended without a handoff
    expect(rows(canon(root, "change", "list").out)).toEqual([`${id(2)}      open       Only on branch  (on branch ${branch})`, `${id(1)}      open       Change 1`]);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(2)} (on branch ${branch}), ${id(1)}\n`);
  });

  test("BR-2291: once main has the change as done, a leftover branch lists it only with --all and without the branch mark", () => {
    const { root } = withBranchOnly();
    ws(root).db.db.query("DELETE FROM claims").run();
    changeFile(root, 2, "done");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "landed");
    expect(ids(canon(root, "change", "list").out)).toEqual([id(1)]);
    expect(rows(canon(root, "change", "list", "--all").out)).toEqual([`${id(2)}      done       Change 2`, `${id(1)}      open       Change 1`]);
  });

  test("BR-2291: a branch whose change file does not parse fails with exit 4 naming it; a branch without the file is not listed", () => {
    const root = project();
    changeFile(root, 1);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "C-1");
    sh(root, "checkout", "-q", "-b", `change/${id(4)}-empty`);
    sh(root, "checkout", "-q", "main");
    expect(ids(canon(root, "change", "list").out)).toEqual([id(1)]);

    sh(root, "checkout", "-q", "-b", `change/${id(3)}-broken`);
    writeFileSync(join(root, `canon/changes/${id(3)}.md`), "no front matter\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "broken");
    sh(root, "checkout", "-q", "main");
    const r = canon(root, "change", "list");
    expect(r.code).toBe(4);
    expect(r.err).toContain(`${id(3)}.md on branch change/${id(3)}-broken`);
  });
});

describe("a branch deleted while listing", () => {
  test("BR-2291: the change file is read from the commit the branch pointed at when listed, so a branch deleted meanwhile still reads", () => {
    const { root, branch } = withBranchOnly();
    const commit = sh(root, "rev-parse", branch);
    sh(root, "worktree", "remove", "--force", join(root, "..", `${root.split("/").pop()}.worktrees`, id(2)));
    sh(root, "branch", "-D", branch); // another session's drop, between listing the branches and reading this one
    const read = changeOnBranch(ws(root), id(2), { branch, commit });
    expect(read.ok && read.value ? [read.value.id, read.value.title, read.value.status] : read).toEqual([id(2), "Only on branch", "open"]);
  });
});

describe("brief's open changes", () => {
  test("BR-2149: with no open change on main, brief still lists a change only on its branch, unclaimed", () => {
    const root = project();
    expect(canon(root, "brief").out).not.toContain("Open changes in the owner's order");
    expect(canon(root, "work", "start", "--title", "X").code).toBe(0);
    ws(root).db.db.query("DELETE FROM claims").run();
    expect(canon(root, "brief").out).toContain(`${PICK}${id(1)} (on branch change/${id(1)}-x)\n`);
  });
});

describe("brief in a claimed worktree", () => {
  test("BR-2024: a change only on its branch shows in the main checkout's brief, never in another change's worktree", () => {
    const { root, wt, branch } = withBranchOnly();
    expect(canon(wt, "work", "stop", "--release", "--next", "land it").code).toBe(0);
    const other = canon(root, "work", "start", id(1));
    expect(other.code).toBe(0);
    const mine = canon(other.out.match(/cd (.+)/)![1]!.trim(), "brief").out;
    expect(mine).toContain(`You are in ${id(1)}`);
    expect(mine).not.toContain(id(2));
    expect(canon(root, "brief").out).toContain(`${id(2)} (on branch ${branch}, handoff)`);
  });
});

describe("started work in the owner's order", () => {
  test("BR-2148: unlisted changes with a handoff come before those without, each by id, after the backlog", () => {
    const root = project();
    for (const n of [1, 2, 3, 4]) changeFile(root, n);
    writeFileSync(join(root, "canon/backlog.md"), `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n1. ${id(3)}\n2. ${id(1)}\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fixture");
    const db = ws(root).db;
    writeHandoff(db, { subject: id(2), worktree: null, actor: "agent:b", next: "go on", note: null });
    expect(ids(canon(root, "change", "list").out)).toEqual([id(3), id(1), id(2), id(4)]);
    db.db.query("DELETE FROM handoffs").run();
    writeHandoff(db, { subject: id(4), worktree: null, actor: "agent:b", next: "go on", note: null });
    expect(ids(canon(root, "change", "list").out)).toEqual([id(3), id(1), id(4), id(2)]);
  });
});
