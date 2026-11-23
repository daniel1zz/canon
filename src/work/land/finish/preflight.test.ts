import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { land } from "../land.ts";

// reason: each case lands; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });

/** A change agent:s1 holds, whose file gets `front` in its front matter and `body` in place of its sections, committed with one more file. */
function change(front: string, body: string | null, extra: Record<string, string> = {}) {
  const root = project(); roots.push(root);
  const s = startNew(root, "Preflight", "agent:s1");
  const dir = join(s.worktree, "canon/changes");
  const path = join(dir, readdirSync(dir).find((p) => p.startsWith(`${s.change}-`) || p === `${s.change}.md`)!);
  let text = readFileSync(path, "utf8").replace(/owner_gate: .*\n/, "").replace("status: open\n", `status: open\n${front}`);
  if (body !== null) text = `${text.slice(0, text.indexOf("---\n", 4) + 4)}\n${body}`;
  writeFileSync(path, text);
  for (const [p, t] of Object.entries({ "work.md": "work\n", ...extra })) writeFileSync(join(s.worktree, p), t);
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "work");
  return { root, ...s };
}
const SECTIONS = "## 为什么\n\nWhy.\n\n## 要改什么\n\nWhat.\n";
const LESSONS = `${SECTIONS}\n## 教训\n\n无。\n`;
const events = (root: string) => ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse' ORDER BY id").all().map((r) => JSON.parse(r.detail) as { reason: string; refusals?: string[] });

test("BR-2634: --finish with no lessons and no owner approval is refused once, naming both, before the queue; the event lists both reasons", async () => {
  const c = change('owner_gate: "设计稿"\n', SECTIONS);
  const r = await land(ws(c.worktree, "agent:s1"), { ...FAST, finish: true }, quiet);
  expect(r.kind).toBe("refused");
  if (r.kind !== "refused") return;
  expect(r.reason).toBe("lessons");
  expect(r.message).toStartWith("2 things to fix before this landing can go on:");
  expect(r.message).toContain("1. [lessons]");
  expect(r.message).toContain("2. [owner-gate]");
  expect(r.message).not.toContain("note: canon check");
  const last = events(c.root).at(-1)!;
  expect(last).toMatchObject({ reason: "lessons", refusals: ["lessons", "owner-gate"] });
  expect(ws(c.root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'land.enqueue'").get()!.n).toBe(0);
});

test("BR-2634: with other refusals, what canon check finds on the branch before the rebase is added as a note", async () => {
  const c = change('owner_gate: "设计稿"\n', `${SECTIONS}\nSee [the missing one](../nowhere/N-999.md).\n`);
  const r = await land(ws(c.worktree, "agent:s1"), { ...FAST, finish: true }, quiet);
  expect(r.kind).toBe("refused");
  if (r.kind !== "refused") return;
  expect(r.message).toContain("note: canon check on this branch, before the rebase onto main, also finds");
});

test("BR-2634 BR-2616: --finish with only the owner approval missing is the owner-gate refusal alone, with no list and no note", async () => {
  const c = change('owner_gate: "设计稿"\n', LESSONS);
  const r = await land(ws(c.worktree, "agent:s1"), { ...FAST, finish: true }, quiet);
  expect(r).toMatchObject({ kind: "refused", reason: "owner-gate" });
  if (r.kind !== "refused") return;
  expect(r.message).not.toContain("things to fix");
  expect(r.message).not.toContain("note: canon check");
});

test("BR-2634 BR-2161: without --finish an unfilled lessons section is no refusal, and nothing missing lands as usual", async () => {
  const c = change('owner_gate: "none: test"\n', SECTIONS);
  expect(await land(ws(c.worktree, "agent:s1"), FAST, quiet)).toMatchObject({ kind: "landed" });
});
