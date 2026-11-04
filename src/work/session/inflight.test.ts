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

/** A project whose main has the open C-1. */
function mainWithC1(): string {
  const root = project();
  changeFile(root, 1);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "C-1");
  return root;
}

/** Makes `branch` from main with what `write` puts in the checkout committed on it, then returns to main. */
function onBranch(root: string, branch: string, write: () => void) {
  sh(root, "checkout", "-q", "-b", branch, "main");
  write();
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "--allow-empty", "-m", branch);
  sh(root, "checkout", "-q", "main");
}

function backlog(root: string, text: string) {
  writeFileSync(join(root, "canon/backlog.md"), `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n${text}`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "backlog");
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

  test("BR-2291: a change branch without its own change file is not listed, nor a change file committed on another change's branch", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(4)}-empty`, () => {});
    onBranch(root, `change/${id(2)}-x`, () => {
      changeFile(root, 2);
      changeFile(root, 7);
    });
    const r = canon(root, "change", "list");
    expect([r.code, ids(r.out)]).toEqual([0, [id(2), id(1)]]);
  });

  test("BR-2291: the owner's backlog orders a change only on its branch like any other", () => {
    const { root, branch } = withBranchOnly();
    ws(root).db.db.query("DELETE FROM claims").run();
    backlog(root, `- ${id(1)}\n`);
    expect(ids(canon(root, "change", "list").out)).toEqual([id(1), id(2)]);
    backlog(root, `- ${id(2)}\n- ${id(1)}\n`);
    expect(ids(canon(root, "change", "list").out)).toEqual([id(2), id(1)]);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(2)} (on branch ${branch}), ${id(1)}\n`);
  });
});

describe("unusual change branches", () => {
  test("BR-2150: canon check accepts a backlog id whose change file is on its own branch only, and still reports one whose branch lacks it", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(9)}-x`, () => changeFile(root, 9));
    backlog(root, `- ${id(9)}\n- ${id(1)}\n`);
    const ok = canon(root, "check");
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining("ok:")]);
    expect(ids(canon(root, "change", "list").out)).toEqual([id(9), id(1)]);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(9)} (on branch change/${id(9)}-x), ${id(1)}\n`);

    onBranch(root, `change/${id(8)}-x`, () => {});
    writeFileSync(join(root, "canon/backlog.md"), `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n- ${id(8)}\n`); // not on main yet: the owner's edit
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`lists ${id(8)}, which is not a change`);
  });

  test("BR-2292: an unreadable change file on a branch is said in brief, which lists the rest and exits 0; change list lists the rest, then fails with exit 4", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(3)}-broken`, () => writeFileSync(join(root, `canon/changes/${id(3)}.md`), "no front matter\n"));
    const brief = canon(root, "brief");
    expect(brief.code).toBe(0);
    expect(brief.out).toContain(`Unreadable change file, not listed: canon/changes/${id(3)}.md on branch change/${id(3)}-broken`);
    expect(brief.out).toContain(`${PICK}${id(1)}\n`);
    const list = canon(root, "change", "list");
    expect(list.code).toBe(4);
    expect(ids(list.out)).toEqual([id(1)]);
    expect(list.err).toContain(`unreadable change file: canon/changes/${id(3)}.md on branch change/${id(3)}-broken`);
    const fine = mainWithC1();
    expect(canon(fine, "change", "list").code).toBe(0);
    expect(canon(fine, "brief").out).not.toContain("Unreadable change file");
  });

  test("BR-2293: a change with several of its branches is listed once, marked ambiguous with all of them, and start refuses it; one branch is plain", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(5)}-a`, () => changeFile(root, 5));
    expect(rows(canon(root, "change", "list").out)[0]).toBe(`${id(5)}      open       Change 5  (on branch change/${id(5)}-a)`);
    onBranch(root, `change/${id(5)}-b`, () => {});
    expect(rows(canon(root, "change", "list").out)[0]).toBe(`${id(5)}      open       Change 5  (ambiguous: change/${id(5)}-a, change/${id(5)}-b)`);
    expect(canon(root, "work", "start", id(5)).code).toBe(2);
    onBranch(root, `change/${id(5)}-c`, () => changeFile(root, 5));
    const data = JSON.parse(canon(root, "change", "list", "--json").out) as { id: string; on_branch: string[] }[];
    expect(data[0]).toMatchObject({ id: id(5), on_branch: [`change/${id(5)}-a`, `change/${id(5)}-b`, `change/${id(5)}-c`] });
    expect(canon(root, "brief").out).toContain(`${PICK}${id(5)} (ambiguous: change/${id(5)}-a, change/${id(5)}-b, change/${id(5)}-c), ${id(1)}\n`);
    expect(canon(root, "work", "start", id(5)).code).toBe(2);

    const broken = mainWithC1();
    onBranch(broken, `change/${id(5)}-a`, () => changeFile(broken, 5));
    onBranch(broken, `change/${id(5)}-c`, () => writeFileSync(join(broken, `canon/changes/${id(5)}.md`), "no front matter\n"));
    const brief = canon(broken, "brief").out;
    expect(brief).toContain(`${PICK}${id(5)} (ambiguous: change/${id(5)}-a, change/${id(5)}-c), ${id(1)}\n`);
    expect(brief).toContain(`Unreadable change file, not listed: canon/changes/${id(5)}.md on branch change/${id(5)}-c`);
  });

  test("BR-2294: a change done only on its branch is listed without --all, marked closed on branch, not landed, and start takes it up; done on main or dropped is not", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(6)}-x`, () => changeFile(root, 6, "done"));
    expect(rows(canon(root, "change", "list").out)[0]).toBe(`${id(6)}      done       Change 6  (on branch change/${id(6)}-x; closed on branch, not landed)`);
    expect(canon(root, "brief").out).toContain(`${PICK}${id(6)} (on branch change/${id(6)}-x, closed on branch, not landed), ${id(1)}\n`);
    expect(canon(root, "work", "start", id(6)).code).toBe(0);

    const dropped = mainWithC1();
    onBranch(dropped, `change/${id(6)}-x`, () => changeFile(dropped, 6, "dropped"));
    expect(ids(canon(dropped, "change", "list").out)).toEqual([id(1)]);
    expect(canon(dropped, "work", "start", id(6)).code).toBe(2);

    const landed = mainWithC1();
    onBranch(landed, `change/${id(6)}-x`, () => changeFile(landed, 6, "done"));
    changeFile(landed, 6, "done");
    sh(landed, "add", "-A");
    sh(landed, "commit", "-qm", "landed");
    expect(ids(canon(landed, "change", "list").out)).toEqual([id(1)]);
  });
});

describe("a branch deleted while listing", () => {
  test("BR-2291: the change file is read from the commit the branch pointed at when listed, so a branch deleted meanwhile still reads", () => {
    const { root, branch } = withBranchOnly();
    const commit = sh(root, "rev-parse", branch);
    sh(root, "worktree", "remove", "--force", join(root, "..", `${root.split("/").pop()}.worktrees`, id(2)));
    sh(root, "branch", "-D", branch); // another session's drop, between listing the branches and reading this one
    const read = changeOnBranch(ws(root), id(2), { branch, commit });
    expect(read.ok && read.value && "change" in read.value ? [read.value.change.id, read.value.change.title, read.value.change.status] : read).toEqual([id(2), "Only on branch", "open"]);
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

describe("brief's unfinished changes", () => {
  test("BR-2149: brief lists a change closed only on its branch among the unfinished ones, marked", () => {
    const root = mainWithC1();
    onBranch(root, `change/${id(6)}-x`, () => changeFile(root, 6, "done"));
    expect(canon(root, "brief").out).toContain(`${PICK}${id(6)} (on branch change/${id(6)}-x, closed on branch, not landed), ${id(1)}\n`);
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
