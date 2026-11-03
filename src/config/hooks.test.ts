import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims } from "../work/claims/claims.ts";
import { handoffs } from "../work/session/handoffs.ts";
import { start, stop } from "../work/session/session.ts";
import { land } from "../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../work/testkit.ts";

function configured(hooks: string) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nhooks:\n${hooks}`);
  sh(root, "commit", "-qam", "hooks");
  return root;
}

const hookRuns = (root: string) =>
  ws(root)
    .db.db.query<{ subject: string | null; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'hook.run' ORDER BY id")
    .all()
    .map((e) => ({ subject: e.subject, ...(JSON.parse(e.detail) as { event: string; command: string; exit: number | null; background?: boolean }) }));

async function commitAndLand(root: string, title: string, file: string) {
  const s = startNew(root, title);
  writeFileSync(join(s.worktree, file), "x\n");
  sh(s.worktree, "add", file);
  sh(s.worktree, "commit", "-qm", file);
  return { s, out: await land(ws(s.worktree), FAST, quiet) };
}

describe("lifecycle hooks", () => {
  test("BR-2056: after_start runs in the new worktree with the change in its environment; its exit code changes nothing", () => {
    const root = configured(`  after_start:\n    - 'echo "$CANON_EVENT $CANON_CHANGE $CANON_BRANCH" > started.txt'\n    - exit 4\n    - echo 2 > second.txt\n`);
    const lines: string[] = [];
    const r = start(ws(root), { title: "Hooked" }, (l) => lines.push(l));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(join(r.value.worktree, "started.txt"), "utf8").trim()).toBe(`after_start ${r.value.change} ${r.value.branch}`);
    expect(lines.join("\n")).toContain("exited 4");
    expect(readFileSync(join(r.value.worktree, "second.txt"), "utf8").trim()).toBe("2"); // a failure does not stop the rest
    expect(claims(ws(root).db).map((c) => c.subject)).toEqual([r.value.change]);
  });

  test("BR-2057: a failing before_land refuses the landing on the tree that would become main; a passing one lets it land", async () => {
    const root = configured(`  before_land: 'test -e CHANGELOG.md && test "$CANON_HEAD" = "$(git rev-parse HEAD)"'\n`);
    const before = sh(root, "rev-parse", "main");
    const refused = await commitAndLand(root, "No changelog", "x.txt");
    expect(refused.out.kind === "refused" && refused.out.reason).toBe("hook");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    const reasons = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse'").all().map((e) => JSON.parse(e.detail).reason);
    expect(reasons).toEqual(["hook"]);
    const ok = await commitAndLand(root, "With changelog", "CHANGELOG.md");
    expect(ok.out.kind).toBe("landed");
  });

  test("BR-2057: before_land does not run when the floor fails", async () => {
    const root = configured(`  before_land: 'touch "${"$"}CANON_WORKTREE/../before-land-ran"'\n`);
    const s = startNew(root, "Red");
    writeFileSync(join(s.worktree, "FAIL"), "x");
    sh(s.worktree, "add", "FAIL");
    sh(s.worktree, "commit", "-qm", "red");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(existsSync(join(s.worktree, "..", "before-land-ran"))).toBe(false);
    expect(hookRuns(root)).toEqual([]);
  });

  test("BR-2056: setup runs first and a failed setup skips after_start; restarting an existing worktree runs after_start again", () => {
    const failing = project();
    writeFileSync(join(failing, "canon/config.yaml"), `floor: "true"\ntests: []\nsetup: "false"\nhooks:\n  after_start: touch "$CANON_WORKTREE/../after-start-ran"\n`);
    sh(failing, "commit", "-qam", "failing setup");
    expect(start(ws(failing), { title: "Broken setup" }, quiet).ok).toBe(false);
    expect(hookRuns(failing)).toEqual([]);

    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nsetup: touch setup-ran\nhooks:\n  after_start: 'test -e setup-ran && echo "$CANON_CHANGE" >> starts.txt'\n`);
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Planned\nstatus: open\n---\n## 为什么\n\nPlanned.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "setup then after_start; a planned change");
    const first = start(ws(root), { change: "C-1" }, quiet);
    if (first.ok) stop(ws(first.value.worktree), "later", undefined, true); // a live claim refuses every start (BR-2011)
    const again = start(ws(root), { change: "C-1" }, quiet); // the worktree exists: no setup, after_start again
    expect(first.ok && again.ok && again.value.created).toBe(false);
    if (!first.ok) return;
    expect(readFileSync(join(first.value.worktree, "starts.txt"), "utf8").trim().split("\n")).toEqual(["C-1", "C-1"]);
    expect(hookRuns(root).map((r) => r.exit)).toEqual([0, 0]);
  });

  test("BR-2058: stop without a claim is not found and after_stop does not run", () => {
    const root = configured(`  after_stop: touch after-stop-ran\n`);
    expect(stop(ws(root), "x", undefined, false).ok).toBe(false);
    expect(existsSync(join(root, "after-stop-ran"))).toBe(false);
    expect(hookRuns(root)).toEqual([]);
  });

  test("BR-2058: after_stop runs after the handoff is recorded, with the next step; its exit code changes nothing", () => {
    const root = configured(`  after_stop:\n    - exit 9\n    - 'echo "$CANON_NEXT" > next.txt'\n`);
    const s = startNew(root, "Pausing");
    const r = stop(ws(s.worktree), "land it", undefined, false);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(s.worktree, "next.txt"), "utf8").trim()).toBe("land it");
    expect(handoffs(ws(root).db).map((h) => h.next)).toEqual(["land it"]);
  });

  test("BR-2059 BR-2030: every hook command is recorded; after_land commands run in the background with a null exit code", async () => {
    const root = configured(`  before_land: exit 0\n  after_land:\n    - 'echo one >> "${"$"}CANON_EVENT.log"'\n    - 'echo two >> "${"$"}CANON_EVENT.log"'\n`);
    const { s, out } = await commitAndLand(root, "Recorded", "x.txt");
    expect(out.kind).toBe("landed");
    const runs = hookRuns(root);
    expect(runs.map((r) => [r.subject, r.event, r.command, r.exit, r.background ?? false])).toEqual([
      [s.change, "before_land", "exit 0", 0, false],
      [s.change, "after_land", 'echo one >> "$CANON_EVENT.log"', null, true],
      [s.change, "after_land", 'echo two >> "$CANON_EVENT.log"', null, true],
    ]);
    const log = join(root, "after_land.log");
    for (let i = 0; i < 50 && !(existsSync(log) && readFileSync(log, "utf8").includes("two")); i++) await Bun.sleep(100);
    expect(readFileSync(log, "utf8")).toBe("one\ntwo\n");
  });

  test("BR-2059: a failing hook is recorded with its exit code", async () => {
    const root = configured(`  before_land: exit 3\n`);
    await commitAndLand(root, "Failing", "x.txt");
    expect(hookRuns(root).map((r) => [r.event, r.exit])).toEqual([["before_land", 3]]);
  });
});
