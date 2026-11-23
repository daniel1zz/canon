import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { land } from "./land.ts";
import { recordFailure } from "../watch/redmain.ts";

// reason: each case lands; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

function fixture(policies = "") {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  if (policies) appendFileSync(join(root, "canon/config.yaml"), `policies:\n${policies}`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return root;
}
/** A change with one committed line of work. */
function work(root: string, title: string) {
  const s = startNew(root, title, "agent:s1");
  writeFileSync(join(s.worktree, `${s.change}.txt`), "x\n");
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "work");
  return s;
}
function red(root: string, change: string | null = null) {
  const w = ws(root);
  recordFailure(w.db, { sha: "9564c3237".padEnd(40, "0"), log: "/logs/watch.log", tail: "boom", green: null, files: ["t/door.test.ts"], reported: true });
  if (change) w.db.db.query("UPDATE red_main SET change = ? WHERE id = 1").run(change);
  w.db.close();
}
const landed = (root: string, change: string) => ws(root).db.db.query("SELECT 1 FROM events WHERE kind = 'land.ok' AND subject = ?").get(change) !== null;

test("BR-2644: while main fails and nobody fixes it, a landing is refused before the queue, naming the commit, the failing files and how to fix", async () => {
  const root = fixture();
  const a = work(root, "Other work");
  red(root);
  const r = await land(ws(a.worktree, "agent:s1"), FAST, quiet);
  expect(r).toMatchObject({ kind: "refused", reason: "red-main" });
  if (r.kind !== "refused") return;
  expect(r.message).toContain("since 9564c3237");
  expect(r.message).toContain("failing test files: t/door.test.ts");
  expect(r.message).toContain("canon work start --fix-main");
  expect(r.message).toContain("policies.landing.pause_on_red_main: false");
  expect(ws(root).db.db.query("SELECT 1 FROM events WHERE kind = 'land.enqueue'").get()).toBeNull();
});

test("BR-2644: the fix change lands; until it has, others wait naming it; once it has, they land again", async () => {
  const root = fixture();
  const fix = work(root, "Fix main");
  const other = work(root, "Other work");
  red(root, fix.change);
  const before = await land(ws(other.worktree, "agent:s1"), FAST, quiet);
  expect(before).toMatchObject({ kind: "refused", reason: "red-main" });
  if (before.kind === "refused") expect(before.message).toContain(`the fix is ${fix.change}, not landed yet`);
  expect(await land(ws(fix.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "landed" });
  expect(await land(ws(other.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "landed" });
  expect(landed(root, other.change)).toBe(true);
});

test("BR-2644: main's policies.landing.pause_on_red_main false lets landings through; a branch turning it off for itself does not", async () => {
  const off = fixture("  landing:\n    pause_on_red_main: false\n");
  const a = work(off, "Other work");
  red(off);
  expect(await land(ws(a.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "landed" });
  const on = fixture();
  const b = work(on, "Turn it off for me");
  appendFileSync(join(b.worktree, "canon/config.yaml"), "policies:\n  landing:\n    pause_on_red_main: false\n");
  sh(b.worktree, "add", "-A"); sh(b.worktree, "commit", "-qm", "off");
  red(on);
  expect(await land(ws(b.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "refused", reason: "red-main" });
});
