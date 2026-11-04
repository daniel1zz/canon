import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUrgent } from "../../knowledge/documents/backlog.ts";
import { recordFailure } from "../watch/redmain.ts";
import { priorityNow } from "./land.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

describe("what jumps the landing queue", () => {
  test("BR-2232: only the items under 优先合入 count, up to the next heading of the same or a higher level", () => {
    const text = "# 待办顺序\n\n1. C-1 first\n\n## 优先合入\n\n- C-2 now\n- [ ] `C-4` too\n\n### 说明\n\n- C-5 still in the section\n\n## 其他\n\n- C-3 later\n";
    expect([...parseUrgent(text)].sort()).toEqual(["C-2", "C-4", "C-5"]);
    expect([...parseUrgent("1. C-1\n2. C-2\n")]).toEqual([]);
  });

  test("BR-2232: the urgent list is read from main; a change editing its own backlog does not jump", () => {
    const root = project();
    const s = startNew(root, "Self promote");
    writeFileSync(join(s.worktree, "canon/backlog.md"), "## 优先合入\n\n- C-1\n");
    sh(s.worktree, "add", "canon/backlog.md");
    sh(s.worktree, "commit", "-qm", "promote myself");
    expect([...priorityNow(ws(s.worktree)).urgent]).toEqual([]);

    writeFileSync(join(root, "canon/backlog.md"), "## 优先合入\n\n- C-1\n");
    sh(root, "add", "canon/backlog.md");
    sh(root, "commit", "-qm", "owner marks C-1 urgent");
    expect([...priorityNow(ws(s.worktree)).urgent]).toEqual(["C-1"]);
  });

  test("BR-2232: the fix change recorded for a failing main is the first priority", () => {
    const root = project();
    const w = ws(root);
    expect(priorityNow(w).fix).toBeUndefined();
    recordFailure(w.db, { sha: "a".repeat(40), log: "/x.log", tail: "boom", green: null });
    w.db.db.query("UPDATE red_main SET change = 'C-7' WHERE id = 1").run();
    expect(priorityNow(w).fix).toBe("C-7");
  });
});
