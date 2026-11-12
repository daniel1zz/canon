import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { recordReport } from "../../verify/ledger.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

describe("floor skip for landings that change only declared paths", () => {
  function skipProject(config: string) {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), config);
    sh(root, "commit", "-qam", "config");
    return root;
  }
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail) as Record<string, unknown>);
  const commitFile = (wt: string, path: string, text: string) => {
    mkdirSync(join(wt, path, ".."), { recursive: true });
    writeFileSync(join(wt, path), text);
    sh(wt, "add", path);
    sh(wt, "commit", "-qm", path);
  };
  const SKIP = 'floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "cat > /dev/null"\n';

  test("BR-2164: only declared paths changed: the floor is skipped, said and recorded, and the landing still lands", async () => {
    const root = skipProject(SKIP);
    const s = startNew(root, "Notes only");
    commitFile(s.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    expect(said.some((m) => m.startsWith("floor: skipped") && m.includes("canon/changes, canon/notes"))).toBe(true);
    const skip = events(root, "floor.skip");
    expect(skip.length).toBe(1);
    expect(skip[0]!["paths"]).toEqual([`canon/changes/${s.change}-notes-only.md`, "canon/notes/N-1.md"]);
    expect(events(root, "land.ok")[0]!["floor_skipped"]).toBe(true);
    expect(events(root, "review.ok").length + events(root, "review.block").length).toBe(0); // no rule review runs in the landing
  });

  test("BR-2164: a path outside the entries, a sibling with the same prefix, a test file, or no entries at all runs the floor", async () => {
    const outside = skipProject(SKIP);
    const a = startNew(outside, "Code too");
    commitFile(a.worktree, "app.txt", "changed\n");
    const r1 = await land(ws(a.worktree), FAST, quiet);
    expect(r1.kind === "refused" && r1.reason).toBe("floor");

    const sibling = skipProject(SKIP);
    const b = startNew(sibling, "Sibling");
    commitFile(b.worktree, "canon/notesx/a.md", "x\n");
    const r2 = await land(ws(b.worktree), FAST, quiet);
    expect(r2.kind === "refused" && r2.reason).toBe("floor");

    const tests = skipProject('floor: "false"\ntests: ["docs/**/*.test.ts"]\nfloor_skip_paths: [canon/changes, docs]\ntest_select_command: "cat > /dev/null"\n');
    const c = startNew(tests, "Test file");
    commitFile(c.worktree, "docs/a.test.ts", "// a test\n");
    // reason: canon check runs before the floor and needs the report `canon work test` wrote for the changed test file (BR-2014, BR-2344)
    recordReport(ws(tests).db, "docs/a.test.ts", sh(c.worktree, "hash-object", "docs/a.test.ts"), [{ suites: [], classname: "", name: "a", runs: true }], "test_command");
    const r3 = await land(ws(c.worktree), FAST, quiet);
    expect(r3.kind === "refused" && r3.reason).toBe("floor");

    const unset = skipProject('floor: "false"\ntests: []\n');
    const d = startNew(unset, "No entries");
    const r4 = await land(ws(d.worktree), FAST, quiet);
    expect(r4.kind === "refused" && r4.reason).toBe("floor");
    for (const root of [outside, sibling, tests, unset]) expect(events(root, "floor.skip")).toEqual([]);
  });

  test("BR-2164: the config on the tree that lands decides: an entry main dropped while the change waited no longer skips", async () => {
    const root = skipProject(SKIP);
    const s = startNew(root, "Stale config");
    commitFile(s.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes]\ntest_select_command: "cat > /dev/null"\n');
    sh(root, "commit", "-qam", "tests now read canon/notes");
    const out = await land(ws(s.worktree), FAST, quiet); // the workspace was opened on the old config
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(events(root, "floor.skip")).toEqual([]);
  });

  test("BR-2164: canon check still refuses after a skipped floor, marked floor_skipped, and stats count no floor run", async () => {
    const root = skipProject(SKIP);
    const s = startNew(root, "Dangling");
    commitFile(s.worktree, "canon/notes/N-1.md", `---\nid: N-1\ntitle: 笔记\n---\n\n见 ${["D", 99].join("-")}。\n`);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(events(root, "land.refuse")[0]!["floor_skipped"]).toBe(true);
    const { computeStats } = await import("../../stats/stats.ts");
    const stats = computeStats(ws(root).db, {}, "2026-11-03");
    expect(stats.find((x) => x.check === "floor")!.runs).toBe(0);
    expect(stats.find((x) => x.check === "check")!.runs).toBe(1);
  });

  test("BR-2164: test_select_command is asked with the landing's paths, and a test file it selects makes the floor run, with the file and the reason said", async () => {
    const root = skipProject(`floor: "false"\ntests: ["src/**/*.test.ts"]\nfloor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "cat > select-stdin.txt; printf 'src/a.test.ts\\\\treads canon/notes\\\\n'"\n`);
    commitFile(root, "src/a.test.ts", "// a test\n");
    const s = startNew(root, "Notes read by a test");
    commitFile(s.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(said).toContain("floor not skipped: test_select_command selects 1 test file(s) for these paths: src/a.test.ts (reads canon/notes)");
    expect(events(root, "floor.skip")).toEqual([]);
  }, 30_000);

  test("BR-2164: a test_select_command that selects nothing lets the floor be skipped; one that fails or names a missing file does not", async () => {
    const nothing = skipProject('floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "cat > /dev/null"\n');
    const a = startNew(nothing, "Nothing selected");
    commitFile(a.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");

    const failing = skipProject('floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "cat > /dev/null; exit 3"\n');
    const b = startNew(failing, "Command fails");
    commitFile(b.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    const said: string[] = [];
    const out = await land(ws(b.worktree), FAST, (m) => said.push(m));
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(said.some((m) => m.startsWith("floor not skipped: test_select_command exited 3"))).toBe(true);

    const missing = skipProject('floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "cat > /dev/null; echo src/gone.test.ts"\n');
    const c = startNew(missing, "Names a missing file");
    commitFile(c.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    const said2: string[] = [];
    const out2 = await land(ws(c.worktree), FAST, (m) => said2.push(m));
    expect(out2.kind === "refused" && out2.reason).toBe("floor");
    expect(said2.some((m) => m.includes("not existing files matching `tests`: src/gone.test.ts"))).toBe(true);
    for (const root of [failing, missing]) expect(events(root, "floor.skip")).toEqual([]);
  }, 60_000);
});
