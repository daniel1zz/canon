import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, sh, startNew, ws } from "../../work/testkit.ts";

// reason: each case lands twice in a throwaway repository; under load one landing takes seconds (C-111)
setDefaultTimeout(60_000);

const BACKLOG = (ids: readonly string[]) => `---\ntitle: 待办顺序\n---\n# 待办顺序\n\n${ids.map((i) => `- ${i}\n`).join("")}`;

/** A project whose main's backlog lists a change whose only branch was then dropped: its id names nothing any more. */
function staleBacklog(): { root: string; stale: string } {
  const root = project();
  const s = startNew(root, "Gone later");
  sh(root, "worktree", "remove", "--force", s.worktree);
  writeFileSync(join(root, "canon/backlog.md"), BACKLOG([s.change]));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "backlog");
  sh(root, "branch", "-D", s.branch); // `canon work drop`, as another session did
  ws(root).db.db.query("DELETE FROM claims").run();
  return { root, stale: s.change };
}

describe("a dangling backlog id blocks only the landing that adds it", () => {
  test("BR-2150: a landing that does not touch the backlog lands while main lists a dropped change, and prints the note", async () => {
    const { root, stale } = staleBacklog();
    const s = startNew(root, "Unrelated");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    sh(s.worktree, "commit", "-qam", "work");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    expect(said.join("\n")).toContain(`note: canon/backlog.md:6: lists ${stale}, which is not a change on main or on a local change branch; remove the line, or restore its branch`);
  });

  test("BR-2150: a landing that adds a backlog id naming no change is refused for check", async () => {
    const { root, stale } = staleBacklog();
    const s = startNew(root, "Typo");
    const typo = ["C", 99].join("-");
    writeFileSync(join(s.worktree, "canon/backlog.md"), BACKLOG([stale, typo]));
    sh(s.worktree, "commit", "-qam", "backlog typo");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(JSON.stringify(out)).toContain(`lists ${typo}, which is not a change`);
    expect(JSON.stringify(out)).not.toContain(`lists ${stale}, which is not a change"`);
  });
});
