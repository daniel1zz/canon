import { describe, expect, test } from "bun:test";
import { followHint } from "./batch.ts";

describe("member that cannot follow its commit on main", () => {
  test("BR-2191: when the index cannot be replaced and the undo fails too, the hint says where things are and never that the branch was left as it is", () => {
    const message = "the index could not be replaced (EIO); the branch was left as it was, but the files could not be put back (error): they hold abc's content, and git status shows them as uncommitted changes";
    const hint = followHint({ kind: "undo", message }, "main");
    expect(hint).toContain("the files could not be put back");
    expect(hint).toContain("`git rebase main`");
    expect(hint).not.toContain("the branch was left as it is;");
  });

  test("BR-2191: when the index cannot be replaced and the undo works, the hint says the branch was left as it is", () => {
    const hint = followHint({ kind: "io", message: "the index could not be replaced (EIO); the branch and the files were left as they were" }, "main");
    expect(hint).toContain("the branch was left as it is");
    expect(hint).toContain("`git rebase main`");
  });
});
