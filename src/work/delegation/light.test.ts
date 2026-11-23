import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAST, project, sh, startNew, ws } from "../testkit.ts";
import { agenda, delegateHead, startHead } from "../reminders/agenda.ts";
import { land } from "../land/land.ts";

// reason: each case spawns canon or lands; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, machine: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1", CANON_MACHINE: machine } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
const changeFile = (wt: string, id: string) => join(wt, "canon/changes", readdirSync(join(wt, "canon/changes")).find((p) => p.startsWith(`${id}-`) || p === `${id}.md`)!);
/** A change started by agent:s1 and committed on its branch, with one line of work so it can be delegated. */
function started(root: string, title: string, extra = "") {
  const s = startNew(root, title, "agent:s1");
  const path = changeFile(s.worktree, s.change);
  const text = readFileSync(path, "utf8").replace(/## 要改什么\n\n[^\n]*\n/, "## 要改什么\n\n- 写一份稿子。\n");
  writeFileSync(path, extra === "" ? text : text.replace("status: open\n", `status: open\n${extra}`));
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "work");
  return s;
}
function fixture() {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return root;
}
/** A ready change written straight on main (nobody started it), so the agenda lists it as delegatable. */
function onMain(root: string, n: number) {
  const id = ["C", n].join("-");
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, `canon/changes/${id}.md`), `---\nid: ${id}\ntitle: Ready ${n}\nstatus: open\nrules: []\nowner_gate: "none: t"\nadvances: "none: t"\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", `ready ${id}`);
  return { change: id };
}
const events = (root: string, kind: string): Record<string, unknown>[] => ws(root, "agent:s1").db.db.query<{ subject: string; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ subject: r.subject, ...(JSON.parse(r.detail) as Record<string, unknown>) }));

test("BR-2632 BR-2526: a light delegation goes past a high load with a line saying so; memory pressure and the slots still refuse it; a heavy delegation is refused for the load", () => {
  const root = fixture();
  const a = started(root, "Design draft");
  const b = started(root, "Code");
  const c = started(root, "Design two");
  const r = cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w1", "--light", "只写设计稿");
  expect(r.code).toBe(0);
  expect(r.text).toContain(`light: 5-minute load 17.0 on 8 CPUs (limit 16), not checked for ${a.change}: 只写设计稿; canon work test and the other heavy steps still wait for the load (BR-2632)`);
  const refused = cli(root, "normal,17,8", "work", "delegate", b.change, "--to", "w2");
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("5-minute load 17.0 on 8 CPUs (limit 16)");
  expect(events(root, "delegation.refuse").some((e) => e.subject === b.change && e["reason"] === "capacity")).toBe(true);
  expect(ws(root, "agent:s1").db.db.query("SELECT 1 FROM delegations WHERE subject = ?").get(b.change)).toBeNull();
  const tight = cli(root, "warn,17,8", "work", "delegate", c.change, "--to", "w3", "--light", "调研");
  expect(tight.code).toBe(1);
  expect(tight.text).toContain("memory pressure warn");
  expect(tight.text).not.toContain("5-minute load");
  // with the load under its limit the line is not said
  expect(cli(root, "normal,1,8", "work", "delegate", c.change, "--to", "w3", "--light", "调研").text).not.toContain("not checked for");
});

test("BR-2632 BR-2526: a light delegation is refused when the slots are used up, without a load reason", () => {
  const root = fixture();
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}delegate_max_workers: 1\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "one slot");
  const a = started(root, "One");
  const b = started(root, "Two");
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1").code).toBe(0);
  const r = cli(root, "normal,17,8", "work", "delegate", b.change, "--to", "w2", "--light", "只写设计稿");
  expect(r.code).toBe(1);
  expect(r.text).toContain("1 of delegate_max_workers (1) in use");
  expect(r.text).not.toContain("5-minute load");
});

test("BR-2632: --light with an empty or blank reason is a usage error and writes no delegation record", () => {
  const root = fixture();
  const a = started(root, "Design");
  for (const why of ["", "  "]) {
    const r = cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1", "--light", why);
    expect([why, r.code]).toEqual([why, 2]);
  }
  expect(ws(root, "agent:s1").db.db.query("SELECT 1 FROM delegations WHERE subject = ?").get(a.change)).toBeNull();
});

test("BR-2632: the delegation record and its events carry the light reason (null when heavy), work status shows it, and a re-delegation rewrites it", () => {
  const root = fixture();
  const a = started(root, "Design");
  const b = started(root, "Code");
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1", "--light", "只写设计稿").code).toBe(0);
  expect(cli(root, "normal,1,8", "work", "delegate", b.change, "--to", "w2").code).toBe(0);
  const create = events(root, "delegation.create");
  expect(create.find((e) => e.subject === a.change)!["light"]).toBe("只写设计稿");
  expect(create.find((e) => e.subject === b.change)!["light"]).toBeNull();
  expect(cli(root, "normal,1,8", "work", "status").text).toMatch(new RegExp(`${a.change}: delegated to w1;.*light: 只写设计稿`));
  expect(cli(root, "normal,1,8", "work", "status").text).not.toMatch(new RegExp(`${b.change}: delegated to w2;[^\\n]*light:`));
  // delegating again without --light does not keep the earlier reason
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w3").code).toBe(0);
  expect(events(root, "delegation.update").find((e) => e.subject === a.change)!["light"]).toBeNull();
  expect(cli(root, "normal,1,8", "work", "status").text).not.toMatch(new RegExp(`${a.change}: delegated to w3;[^\\n]*light:`));
});

test("BR-2632: turning a light delegation heavy checks the load only; the other re-delegations are not checked", () => {
  const root = fixture();
  const a = started(root, "Design");
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1", "--light", "只写设计稿").code).toBe(0);
  // light to heavy at a high load: refused for the load, the record is still light and w1's
  const refused = cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w2");
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("5-minute load 17.0 on 8 CPUs (limit 16)");
  expect(events(root, "delegation.refuse").some((e) => e.subject === a.change && e["reason"] === "capacity")).toBe(true);
  const row = ws(root, "agent:s1").db.db.query<{ worker: string; light: string }, [string]>("SELECT worker, light FROM delegations WHERE subject = ?").get(a.change)!;
  expect(row).toEqual({ worker: "w1", light: "只写设计稿" });
  // memory pressure does not refuse a re-delegation
  expect(cli(root, "warn,1,8", "work", "delegate", a.change, "--to", "w2").code).toBe(0);
  // heavy to light, light to light and heavy to heavy at a high load are not checked
  expect(cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w2", "--light", "只剩改文字").code).toBe(0);
  expect(cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w3", "--light", "只剩改文字").code).toBe(0);
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w3").code).toBe(0);
  expect(cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w2").code).toBe(0);
});

test("BR-2632 BR-2581: the agenda says how many held slots are light and, with only the load in the way, that light delegations still fit; memory pressure says neither", () => {
  const root = fixture();
  const a = started(root, "Held light");
  const b = started(root, "Held heavy");
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1", "--light", "只写设计稿").code).toBe(0);
  expect(cli(root, "normal,1,8", "work", "delegate", b.change, "--to", "w2").code).toBe(0);
  const c = onMain(root, 21), d = onMain(root, 22);
  const read = (tight: boolean, load: number) => () => ({ memory: { tight, text: tight ? "memory pressure warn" : "memory pressure normal" }, machine: { load5: load, cpus: 8 } });
  const calm = agenda(ws(root, "agent:s2"), { read: read(false, 4.2) });
  if (!calm.ok) throw new Error(calm.error.message);
  expect(delegateHead(calm.value.delegate!)).toContain(`room for 8 more (load 4.2 of 16 on 8 CPUs, 2/10 slots (1 light: ${a.change})`);
  const busy = agenda(ws(root, "agent:s2"), { read: read(false, 17) });
  if (!busy.ok) throw new Error(busy.error.message);
  const head = delegateHead(busy.value.delegate!);
  expect(head).toBe(`delegate: busy (5-minute load 17.0 on 8 CPUs (limit 16)); 2/10 slots (1 light: ${a.change}); light delegations still fit 8: canon work delegate <C-n> --to <name> --light "<why>"; delegatable once it falls: ${c.change}, ${d.change}`);
  expect(startHead(busy.value.delegate!)).toContain("light delegations still fit 8");
  const json = JSON.parse(cli(root, "normal,17,8", "work", "due", "--json").text) as { delegate: { light: string[]; light_fits: boolean; cpu_light_now?: unknown } };
  expect(json.delegate.light).toEqual([a.change]);
  expect(json.delegate.light_fits).toBe(true);
  expect(json.delegate.cpu_light_now).toBeUndefined();
  const tight = agenda(ws(root, "agent:s2"), { read: read(true, 17) });
  if (!tight.ok) throw new Error(tight.error.message);
  expect(delegateHead(tight.value.delegate!)).not.toContain("light delegations still fit");
});

test("BR-2632 BR-2581: a busy head whose slots are used up names the light delegations in the reason", () => {
  const root = fixture();
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}delegate_max_workers: 2\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "two slots");
  const a = started(root, "Light one");
  const b = started(root, "Heavy one");
  expect(cli(root, "normal,1,8", "work", "delegate", a.change, "--to", "w1", "--light", "只写设计稿").code).toBe(0);
  expect(cli(root, "normal,1,8", "work", "delegate", b.change, "--to", "w2").code).toBe(0);
  onMain(root, 21);
  const full = agenda(ws(root, "agent:s2"), { read: () => ({ memory: { tight: false, text: "n" }, machine: { load5: 1, cpus: 8 } }) });
  if (!full.ok) throw new Error(full.error.message);
  expect(delegateHead(full.value.delegate!)).toContain(`busy (2 of delegate_max_workers (2) in use (1 light: ${a.change}))`);
});

test("BR-2632: land --finish of a change delegated light that changed a path outside floor_skip_paths notes it and still closes; skipped paths only, or a heavy delegation, is not noted", async () => {
  const root = fixture();
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}floor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "true"\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "skip notes");
  const heavy = started(root, "Marked light");
  const notes = started(root, "Notes only");
  const plain = started(root, "Plain");
  // reason: delegating releases the owner's claim, so the delegation rows are written beside the claims the test lands with
  const record = (change: string, light: string | null) => ws(root, "agent:s1").db.db.query("INSERT INTO delegations(subject,worker,owner,revision,epoch,acceptor,manifest,task_hash,light) VALUES (?,?,?,?,?,?,?,?,?)").run(change, "w1", "agent:s1", "x", 1, null, "[]", "x", light);
  record(heavy.change, "只写设计稿"); record(notes.change, "调研笔记"); record(plain.change, null);
  writeFileSync(join(heavy.worktree, "a.ts"), "export const a = 1;\n");
  sh(heavy.worktree, "add", "-A"); sh(heavy.worktree, "commit", "-qm", "code");
  const said: string[] = [];
  expect(await land(ws(heavy.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => said.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(said).toContain(`note: ${heavy.change} was delegated light (只写设计稿) but changes 1 path(s) outside floor_skip_paths, which tests cover (a.ts); delegate implementation work without --light`);
  mkdirSync(join(notes.worktree, "canon/notes"), { recursive: true });
  writeFileSync(join(notes.worktree, "canon/notes/N-1.md"), "---\nid: N-1\ntitle: n\n---\n\nnote\n");
  sh(notes.worktree, "add", "-A"); sh(notes.worktree, "commit", "-qm", "notes");
  const none: string[] = [];
  expect(await land(ws(notes.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => none.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(none.some((l) => l.includes("delegated light"))).toBe(false);
  writeFileSync(join(plain.worktree, "b.ts"), "export const b = 1;\n");
  sh(plain.worktree, "add", "-A"); sh(plain.worktree, "commit", "-qm", "code");
  const quiet: string[] = [];
  expect(await land(ws(plain.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => quiet.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(quiet.some((l) => l.includes("delegated light"))).toBe(false);
});

test("BR-2632: a change still writing cpu_light is reported by canon check, and the field does not change a delegation", () => {
  const root = fixture();
  const s = started(root, "Old field", 'cpu_light: "只写设计稿"\n');
  const r = cli(s.worktree, "normal,1,8", "check");
  expect(r.text).toContain("`cpu_light` has been removed");
  expect(r.text).toContain("--light");
  // the old field no longer lets a delegation past the load
  const refused = cli(root, "normal,17,8", "work", "delegate", s.change, "--to", "w1");
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("5-minute load 17.0 on 8 CPUs (limit 16)");
});

test("BR-2642: a heavy delegation refused for the load alone says a light one still fits, how many more, and that light opens only the delegation; refused also for memory or slots, it does not", () => {
  const root = fixture();
  const a = started(root, "Design draft");
  const r = cli(root, "normal,17,8", "work", "delegate", a.change, "--to", "w1");
  expect(r.code).toBe(1);
  expect(r.text).toContain(`A light delegation still fits (10 more): when the worker only reads, designs or researches, running no tests or builds, canon work delegate ${a.change} --to <name> --light "<why>" (BR-2632). Light opens only the delegation: canon work test and the other heavy steps still wait for the load (BR-2630)`);
  expect(events(root, "delegation.refuse").at(-1)).toMatchObject({ subject: a.change, reason: "capacity", light_fits: 10 });
  const tight = cli(root, "warn,17,8", "work", "delegate", a.change, "--to", "w1");
  expect(tight.code).toBe(1);
  expect(tight.text).not.toContain("A light delegation still fits");
  expect(events(root, "delegation.refuse").at(-1)!["light_fits"]).toBeUndefined();
});
