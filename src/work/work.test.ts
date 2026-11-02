import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "../app/workspace.ts";
import { claims, takeClaim } from "../coord/state.ts";
import { readCorpus } from "../knowledge/read.ts";
import { git } from "../repo/git.ts";
import { clean, land, start, stop } from "./work.ts";

const quiet = () => {};
const FAST = { finish: false, timeoutMs: 20_000 };

function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A repo whose floor passes unless a file named FAIL exists in the tree. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-work-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\n");
  writeFileSync(join(root, "app.txt"), "one\ntwo\nthree\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "init");
  return root;
}

function ws(cwd: string, actor = "agent:a"): Workspace {
  process.env["CANON_ACTOR"] = actor;
  const r = openWorkspace(cwd);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function startNew(root: string, title: string, actor = "agent:a") {
  const r = start(ws(root, actor), { title }, quiet);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("work start", () => {
  test("BR-2012: a new change gets its own worktree, branch, committed change file and claim", () => {
    const root = project();
    const s = startNew(root, "Refund window");
    expect(s.change).toBe("C-1");
    expect(existsSync(join(s.worktree, "canon/changes/C-1-refund-window.md"))).toBe(true);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(claims(ws(root).db).map((c) => [c.subject, c.holder])).toEqual([["C-1", s.worktree]]);
  });

  test("BR-2012: an open change on main is started even when the primary checkout has another branch out", async () => {
    const root = project();
    const s = startNew(root, "Planned");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    sh(root, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "app.txt"), "diverged\n");
    sh(root, "rm", "-rq", "canon/changes");
    sh(root, "commit", "-qam", "elsewhere: no changes dir");
    sh(root, "worktree", "remove", s.worktree);
    const again = start(ws(root, "agent:b"), { change: s.change }, quiet);
    expect(again.ok).toBe(true);
    if (again.ok) expect(readFileSync(join(again.value.worktree, "app.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("BR-2011: a change claimed by another worktree is refused while its lease is live", () => {
    const root = project();
    const s = startNew(root, "A");
    const other = takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("conflict");
  });
});

describe("rule review at land", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return { root, promptFile };
  }

  test("BR-2009: a block verdict on changed rule text refuses the landing; the reviewer saw the whole domain", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("is vague");
    expect(readFileSync(promptFile, "utf8")).toContain("# Domain: billing");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2010: the reviewer is not asked when no rule or decision text changed", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Code only");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "code");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("work land", () => {
  test("BR-2017: lands a committed branch: main moves and the primary checkout's files follow", async () => {
    const root = project();
    const s = startNew(root, "Add four");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "four");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).toBe(sh(s.worktree, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "app.txt"), "utf8")).toContain("four");
  });

  test("BR-2013 BR-2014 BR-2015: refuses uncommitted work, a red floor and a rebase conflict, leaving main untouched", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");

    const a = startNew(root, "Dirty");
    writeFileSync(join(a.worktree, "app.txt"), "changed\n");
    const dirty = await land(ws(a.worktree), FAST, quiet);
    expect(dirty.kind === "refused" && dirty.reason).toBe("dirty");

    const b = startNew(root, "Red");
    writeFileSync(join(b.worktree, "FAIL"), "x");
    sh(b.worktree, "add", "FAIL");
    sh(b.worktree, "commit", "-qm", "red");
    const red = await land(ws(b.worktree), FAST, quiet);
    expect(red.kind === "refused" && red.reason).toBe("floor");
    expect(sh(root, "rev-parse", "main")).toBe(before);

    const c = startNew(root, "Edit two");
    const d = startNew(root, "Edit two again");
    writeFileSync(join(c.worktree, "app.txt"), "one\nTWO\nthree\n");
    sh(c.worktree, "commit", "-qam", "c");
    writeFileSync(join(d.worktree, "app.txt"), "one\n2\nthree\n");
    sh(d.worktree, "commit", "-qam", "d");
    expect((await land(ws(c.worktree), FAST, quiet)).kind).toBe("landed");
    const conflict = await land(ws(d.worktree), FAST, quiet);
    expect(conflict.kind === "refused" && conflict.reason).toBe("conflict");
    expect(sh(d.worktree, "status", "--porcelain")).toBe(""); // rebase was aborted, work intact
  });

  test("BR-2016: refuses when canon check finds a broken corpus", async () => {
    const root = project();
    const s = startNew(root, "Bad ref");
    writeFileSync(join(s.worktree, "canon/changes/C-1-bad-ref.md"), "---\nid: C-1\ntitle: Bad ref\n---\nSee D-99.\n");
    sh(s.worktree, "commit", "-qam", "dangling");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => f.rule)).toEqual(["ref-dangling"]);
  });

  test("BR-2018 BR-2019: --finish closes the change, releases the claim, and clean removes only fully landed worktrees", async () => {
    const root = project();
    const done = startNew(root, "Done one");
    writeFileSync(join(done.worktree, "new.txt"), "x\n");
    sh(done.worktree, "add", "new.txt");
    sh(done.worktree, "commit", "-qm", "x");
    const out = await land(ws(done.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
    const change = readCorpus(root).corpus.docs.find((d) => d.id === "C-1");
    expect(change?.kind === "change" && change.status).toBe("done");
    expect(claims(ws(root).db)).toEqual([]);

    const open = startNew(root, "Unlanded");
    writeFileSync(join(open.worktree, "wip.txt"), "wip\n");
    sh(open.worktree, "add", "wip.txt");
    sh(open.worktree, "commit", "-qm", "wip");
    stop(ws(open.worktree), "finish wip", undefined, true);

    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([done.worktree]);
    expect(existsSync(open.worktree)).toBe(true);
    expect(r.value.kept.join("\n")).toContain("not on main");
  });
});

describe("boundaries record and clean up", () => {
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind);

  test("BR-2026: early land refusals and a refused claim are recorded with their reason", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    await land(ws(s.worktree), FAST, quiet);
    expect(await land(ws(root), FAST, quiet)).toMatchObject({ kind: "refused", reason: "on-main" });
    takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    const reasons = events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason);
    expect(reasons).toEqual(["dirty", "on-main"]);
    expect(events(root, "claim.refuse").map((e) => e.subject)).toEqual([s.change]);
  });

  test("BR-2031: landing from main is refused", async () => {
    const root = project();
    const out = await land(ws(root), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("on-main");
  });

  test("BR-2029: a failed setup removes the new worktree and releases the change, so a retry starts clean", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nsetup: \"test -e .ok\"\n");
    sh(root, "commit", "-qam", "setup that fails");
    const first = start(ws(root), { title: "Needs setup" }, quiet);
    expect(first.ok).toBe(false);
    expect(claims(ws(root).db)).toEqual([]);
    const wts = sh(root, "worktree", "list");
    expect(wts.split("\n").length).toBe(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    expect(events(root, "start.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["setup"]);
  });

  test("BR-2030: after_land runs in the background with the landing's commits and never changes the result", async () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-after.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nafter_land: 'echo "$CANON_BASE $CANON_HEAD $CANON_CHANGE" > ${marker}; exit 7'\n`);
    sh(root, "commit", "-qam", "after_land");
    const s = startNew(root, "With hook");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(100);
    const [base, head, change] = readFileSync(marker, "utf8").trim().split(" ");
    expect(head).toBe(sh(root, "rev-parse", "main"));
    expect(base).toBe(sh(root, "rev-parse", "main~2")); // the open-change commit and x are the landed ones
    expect(change).toBe(s.change);
  });
});
