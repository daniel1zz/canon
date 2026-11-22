import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";
import { delegateImplicitly } from "./implicit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const rule = (id: string, body: string, extra = "") => `---\nid: ${id}\ntitle: ${id}\nstatus: planned\nbusiness: dispatch\n${extra}---\n\n## 规则\n\n${body}\n\n## 例子\n\n- Works.\n`;
function put(root: string, path: string, text: string) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
function commit(root: string) { sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture"); }
function cli(root: string, actor: string, args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env } as Record<string, string | undefined>;
  // reason: fixed machine readings, so a busy machine running this test does not decide what it sees (BR-2526)
  delete base["CLAUDE_DELEGATE_CHILD"]; delete base["CANON_SUBAGENT"];
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...base, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")), ...env } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
function repo(config = "") {
  const root = project(); roots.push(root);
  if (config) writeFileSync(join(root, "canon/config.yaml"), readFileSync(join(root, "canon/config.yaml"), "utf8") + config);
  put(root, "canon/product.md", "# Product\n\nShared work.\n");
  put(root, "canon/rules/task/BR-50.md", rule("BR-50", "Do the first thing.", "will_amend: [BR-52]\n"));
  put(root, "canon/rules/task/BR-51.md", rule("BR-51", "Do another thing."));
  put(root, "canon/rules/task/BR-52.md", rule("BR-52", "The rule a planned rule amends."));
  commit(root);
  return root;
}
/** A change made by `owner` with `rules`; released unless `keep`, so it is open and unclaimed. */
function change(root: string, title: string, owner: string, rules: string[], keep = false) {
  const s = startNew(root, title, owner);
  const path = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((p) => p.startsWith(`${s.change}-`) || p === `${s.change}.md`)!);
  if (rules.length > 0) { writeFileSync(path, readFileSync(path, "utf8").replace(/rules: \[\]/, `rules: [${rules.join(", ")}]`)); commit(s.worktree); }
  if (!keep) expect(cli(s.worktree, owner, ["work", "stop", "--reason", "partial", "--next", "later", "--release"]).code).toBe(0);
  return s;
}
function delegationEvent(root: string, subject: string) {
  const w = ws(root); try { return w.db.db.query<{ actor: string; detail: string }, [string]>("SELECT actor,detail FROM events WHERE subject = ? AND kind = 'delegation.create' ORDER BY id DESC LIMIT 1").get(subject); } finally { w.db.close(); }
}
function claimOf(root: string, subject: string) {
  const w = ws(root); try { return w.db.db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(subject)?.holder; } finally { w.db.close(); }
}

test("BR-2608: starting or delegating a change names each change in progress whose contract rules it shares, and who works on it", () => {
  const root = repo();
  const a = change(root, "First", "agent:s1", ["BR-51"], true);
  const b = change(root, "Second", "agent:s2", ["BR-51"]);
  const c = change(root, "Third", "agent:s4", ["BR-50"]);
  const started = cli(root, "agent:s3", ["work", "start", b.change]);
  expect(started.code).toBe(0);
  expect(started.text).toContain(`${b.change} shares BR-51 with ${a.change} (claimed by agent:s1)`);
  expect(started.text).toContain("depends_on");
  // reason: C's contract is BR-50 and its will_amend target BR-52; neither is A's or B's
  const third = cli(root, "agent:s5", ["work", "delegate", c.change, "--to", "w5"]);
  expect(third.code).toBe(0);
  expect(third.text).not.toContain(" shares ");
  const d = change(root, "Fourth", "agent:s6", ["BR-52"]);
  const fourth = cli(root, "agent:s6", ["work", "start", d.change]);
  expect(fourth.code).toBe(0);
  expect(fourth.text).toContain(`${d.change} shares BR-52 with ${c.change} (delegated to w5 by agent:s5)`);
});

test("BR-2609: delegating a change whose planned rule will amend a rule not yet naming it says the design is not settled", () => {
  const root = repo();
  const a = change(root, "Amends", "agent:s1", ["BR-50"]);
  const started = cli(root, "agent:s1", ["work", "start", a.change]);
  expect(started.code).toBe(0);
  expect(started.text).not.toContain("design not settled");
  expect(cli(a.worktree, "agent:s1", ["work", "stop", "--reason", "partial", "--next", "x", "--release"]).code).toBe(0);
  const first = cli(root, "agent:s1", ["work", "delegate", a.change, "--to", "w1"]);
  expect(first.code).toBe(0);
  expect(first.text).toContain("design not settled: BR-50 will amend BR-52");
  put(root, "canon/rules/task/BR-52.md", rule("BR-52", "The rule BR-50 amends; with BR-50 it also does more.")); commit(root);
  const again = cli(root, "agent:s1", ["work", "delegate", a.change, "--to", "w1"]);
  expect(again.code).toBe(0);
  expect(again.text).not.toContain("design not settled");
});

test("BR-2610 BR-2498: a main session's own subagent starts an undelegated change; the session is recorded as its design owner", () => {
  const root = repo();
  const a = change(root, "Own subagent", "agent:s1", ["BR-51"]);
  const r = cli(root, "agent:s1:sub1", ["work", "start", a.change]);
  expect(r.code).toBe(0);
  expect(r.text).toContain("implicit");
  expect(r.text).not.toContain("machine busy");
  const e = delegationEvent(root, a.change)!;
  expect(e.actor).toBe("agent:s1");
  expect(JSON.parse(e.detail)).toMatchObject({ owner: "agent:s1", worker: "sub1", implicit: true, by: "agent:s1:sub1", epoch: 1 });
  expect(claimOf(root, a.change)).toBe("agent:s1:sub1");
});

test("BR-2610 BR-2498: a worker another session started, or a change with a live claim, is still refused as undelegated", () => {
  const root = repo();
  const a = change(root, "Launched worker", "agent:s1", ["BR-51"]);
  const launched = cli(root, "agent:s1:w1", ["work", "start", a.change], { CLAUDE_DELEGATE_CHILD: "1" });
  expect(launched.code).toBe(1);
  expect(launched.text).toContain("未派发");
  expect(delegationEvent(root, a.change)).toBeNull();
  const b = change(root, "Held", "agent:s2", ["BR-51"], true);
  const held = cli(root, "agent:s2:sub1", ["work", "start", b.change]);
  expect(held.code).toBe(1);
  expect(held.text).toContain("未派发");
  expect(claimOf(root, b.change)).toBe("agent:s2");
});

test("BR-2610: a change the main session claims after its subagent was found eligible is not delegated implicitly; the claim stays the session's and the refusal is recorded (#294)", () => {
  const root = repo();
  // the main session starts the change between the subagent's eligibility check and its delegation
  const a = change(root, "Raced", "agent:s1", ["BR-51"], true);
  const w = ws(root, "agent:s1:sub1");
  const r = delegateImplicitly(w, a.change, quiet);
  w.db.close();
  expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(!r.ok && r.error.message).toContain(`${a.change} was claimed by agent:s1 while agent:s1:sub1 was starting it; it is not delegated`);
  expect(delegationEvent(root, a.change)).toBeNull();
  expect(claimOf(root, a.change)).toBe("agent:s1");
  const v = ws(root);
  try { expect(JSON.parse(v.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE subject = ? AND kind = 'delegation.refuse'").get(a.change)!.detail)).toMatchObject({ reason: "conflict", implicit: true, by: "agent:s1:sub1", holder: "agent:s1" }); } finally { v.db.close(); }
});

test("BR-2610 BR-2526: the implicit delegation is not refused for machine capacity", () => {
  const root = repo("delegate_max_workers: 1\n");
  const x = change(root, "Occupies the slot", "agent:s1", ["BR-52"]);
  expect(cli(root, "agent:s1", ["work", "delegate", x.change, "--to", "w9"]).code).toBe(0);
  const a = change(root, "Busy machine", "agent:s1", ["BR-51"]);
  expect(cli(root, "agent:s1", ["work", "delegate", a.change, "--to", "w2"]).code).toBe(1);
  const r = cli(root, "agent:s1:sub1", ["work", "start", a.change]);
  expect(r.code).toBe(0);
  expect(r.text).toContain("machine busy: ");
  expect(r.text).toContain("delegate_max_workers");
  expect(claimOf(root, a.change)).toBe("agent:s1:sub1");
});

test("BR-2614: delegating a change whose text names a planned rule missing from rules: says to add it; a listed or active one is not said", () => {
  const root = repo();
  put(root, "canon/rules/task/BR-53.md", rule("BR-53", "Already built.").replace("status: planned", "status: active")); commit(root);
  const a = change(root, "Names a planned rule", "agent:s1", []);
  const path = join(a.worktree, "canon/changes", readdirSync(join(a.worktree, "canon/changes")).find((p) => p.startsWith(`${a.change}-`) || p === `${a.change}.md`)!);
  writeFileSync(path, readFileSync(path, "utf8").replace("## 要改什么\n", "## 要改什么\n\n- BR-51 的加载检查，按 `BR-53` 的写法。\n")); commit(a.worktree);
  const r = cli(root, "agent:s1", ["work", "delegate", a.change, "--to", "w1"]);
  expect(r.code).toBe(0);
  expect(r.text).toContain(`not in rules: BR-51 is planned and named in ${a.change}'s text`);
  expect(r.text).not.toContain("not in rules: BR-53");
  const b = change(root, "Lists it", "agent:s2", ["BR-51"]);
  const listed = cli(root, "agent:s2", ["work", "delegate", b.change, "--to", "w2"]);
  expect(listed.code).toBe(0);
  expect(listed.text).not.toContain("not in rules:");
});
