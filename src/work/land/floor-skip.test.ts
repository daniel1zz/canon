import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

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
  const SKIP = 'floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\n';

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

    const tests = skipProject('floor: "false"\ntests: ["docs/**/*.test.ts"]\nfloor_skip_paths: [canon/changes, docs]\n');
    const c = startNew(tests, "Test file");
    commitFile(c.worktree, "docs/a.test.ts", "// a test\n");
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
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes]\n');
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
    const { computeStats } = await import("../stats/stats.ts");
    const stats = computeStats(ws(root).db, {}, "2026-11-03");
    expect(stats.find((x) => x.check === "floor")!.runs).toBe(0);
    expect(stats.find((x) => x.check === "check")!.runs).toBe(1);
  });

  test("BR-2181: a test reading the repository's file under an entry the landing tree's config added while the change waited is refused by canon check", async () => {
    const root = skipProject('floor: "true"\ntests: ["src/**/*.test.ts"]\nfloor_skip_paths: [canon/changes]\n');
    const s = startNew(root, "Reads notes");
    // reason: assembled from pieces so this file itself does not read like such a test (BR-2181)
    const meta = ["import", "meta", "dir"].join(".");
    const notes = ["canon", "notes"].join("/");
    commitFile(s.worktree, "src/a.test.ts", `const ROOT = join(${meta}, "..");\nconst t = readFileSync(join(ROOT, "${notes}/N-1.md"));\n`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["src/**/*.test.ts"]\nfloor_skip_paths: [canon/changes, ${notes}]\n`);
    sh(root, "commit", "-qam", "skip notes");
    const out = await land(ws(s.worktree), FAST, quiet); // the workspace was opened on the config without canon/notes
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => `${f.rule} ${f.path}`)).toEqual(["test-reads-skip-path src/a.test.ts:2"]);
  });
});
