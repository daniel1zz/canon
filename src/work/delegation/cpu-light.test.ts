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
/** A change started by agent:s1, with `cpu_light` set to `light` (a YAML value) unless undefined, committed on its branch. */
function started(root: string, title: string, light?: string) {
  const s = startNew(root, title, "agent:s1");
  const path = changeFile(s.worktree, s.change);
  const text = readFileSync(path, "utf8").replace(/## 要改什么\n\n[^\n]*\n/, "## 要改什么\n\n- 写一份稿子。\n");
  writeFileSync(path, light === undefined ? text : text.replace("status: open\n", `status: open\ncpu_light: ${light}\n`));
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "cpu_light");
  return s;
}
function fixture() {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return root;
}

test("BR-2627 BR-2526: a cpu_light change is delegated past a high load with a line saying so; memory pressure still refuses it; a change without cpu_light is refused for the load", () => {
  const root = fixture();
  const light = started(root, "Design draft", '"只写设计稿"');
  const plain = started(root, "Code");
  const other = started(root, "Design two", '"调研笔记"');
  const r = cli(root, "normal,17,8", "work", "delegate", light.change, "--to", "w1");
  expect(r.code).toBe(0);
  expect(r.text).toContain(`cpu_light: 5-minute load 17.0 on 8 CPUs (limit 16), not checked for ${light.change}: 只写设计稿 (BR-2627)`);
  const refused = cli(root, "normal,17,8", "work", "delegate", plain.change, "--to", "w2");
  expect(refused.code).toBe(1);
  expect(refused.text).toContain("5-minute load 17.0 on 8 CPUs (limit 16)");
  const tight = cli(root, "warn,17,8", "work", "delegate", other.change, "--to", "w3");
  expect(tight.code).toBe(1);
  expect(tight.text).toContain("memory pressure warn");
  expect(tight.text).not.toContain("5-minute load");
  // with the load under its limit the line is not said
  expect(cli(root, "normal,1,8", "work", "delegate", other.change, "--to", "w3").text).not.toContain("cpu_light:");
});

test("BR-2627 BR-2581: with only the load in the way the agenda lists cpu_light changes as delegatable now, with a fact; memory pressure lists none", () => {
  const root = fixture();
  const C = (n: number) => ["C", n].join("-");
  const doc = (n: number, front = "") => `---\nid: ${C(n)}\ntitle: Work ${n}\nstatus: open\nrules: []\nowner_gate: "none: t"\nadvances: "none: t"\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, `canon/changes/${C(1)}.md`), doc(1, 'cpu_light: "只写设计稿"\n'));
  writeFileSync(join(root, `canon/changes/${C(2)}.md`), doc(2));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "changes");
  const light = { change: C(1) }, plain = { change: C(2) };
  const read = (tight: boolean) => () => ({ memory: { tight, text: tight ? "memory pressure warn" : "memory pressure normal" }, machine: { load5: 17, cpus: 8 } });
  const busy = agenda(ws(root, "agent:s2"), { read: read(false) });
  if (!busy.ok) throw new Error(busy.error.message);
  const d = busy.value.delegate!;
  expect(d.room.room).toBe(false);
  expect(delegateHead(d)).toBe(`delegate: busy (5-minute load 17.0 on 8 CPUs (limit 16)); cpu_light, delegatable now: ${light.change}; delegatable once it falls: ${plain.change}`);
  expect(startHead(d)).toContain(`cpu_light, delegatable now: ${light.change}`);
  expect(d.ready.find((r) => r.id === light.change)!.facts).toContain("cpu_light: 只写设计稿; the load does not stop delegating it (BR-2627)");
  expect(d.ready.find((r) => r.id === plain.change)!.facts.some((f) => f.startsWith("cpu_light"))).toBe(false);
  const json = JSON.parse(cli(root, "normal,17,8", "work", "due", "--json").text) as { delegate: { cpu_light_now: string[] } };
  expect(json.delegate.cpu_light_now).toEqual([light.change]);
  const tight = agenda(ws(root, "agent:s2"), { read: read(true) });
  if (!tight.ok) throw new Error(tight.error.message);
  expect(delegateHead(tight.value.delegate!)).not.toContain("cpu_light");
});

test("BR-2627: land --finish of a cpu_light change that changed a path outside floor_skip_paths notes it and still closes; one that changed only skipped paths, or a change without cpu_light, is not noted", async () => {
  const root = fixture();
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}floor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: "true"\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "skip notes");
  const heavy = started(root, "Heavy", '"只写设计稿"');
  writeFileSync(join(heavy.worktree, "a.ts"), "export const a = 1;\n");
  sh(heavy.worktree, "add", "-A"); sh(heavy.worktree, "commit", "-qm", "code");
  const said: string[] = [];
  expect(await land(ws(heavy.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => said.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(said).toContain(`note: ${heavy.change} is cpu_light (只写设计稿) but changes 1 path(s) outside floor_skip_paths, which tests cover (a.ts); its worker ran tests and added load: mark such work cpu_light no more (BR-2627)`);
  const notes = started(root, "Notes only", '"调研笔记"');
  mkdirSync(join(notes.worktree, "canon/notes"), { recursive: true });
  writeFileSync(join(notes.worktree, "canon/notes/N-1.md"), "---\nid: N-1\ntitle: n\n---\n\nnote\n");
  sh(notes.worktree, "add", "-A"); sh(notes.worktree, "commit", "-qm", "notes");
  const none: string[] = [];
  expect(await land(ws(notes.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => none.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(none.some((l) => l.includes("cpu_light"))).toBe(false);
  const plain = started(root, "Plain");
  writeFileSync(join(plain.worktree, "b.ts"), "export const b = 1;\n");
  sh(plain.worktree, "add", "-A"); sh(plain.worktree, "commit", "-qm", "code");
  const quiet: string[] = [];
  expect(await land(ws(plain.worktree, "agent:s1"), { ...FAST, finish: true }, (l) => quiet.push(l))).toMatchObject({ kind: "landed", finished: true });
  expect(quiet.some((l) => l.includes("cpu_light"))).toBe(false);
});

test("BR-2627: cpu_light empty or not a text is a format error canon check reports", () => {
  const root = fixture();
  for (const [value, bad] of [['"只写设计稿"', false], ['""', true], ["true", true]] as const) {
    const s = started(root, `Check ${value}`, value);
    const r = cli(s.worktree, "normal,1,8", "check");
    expect([value, r.text.includes("cpu_light")]).toEqual([value, bad]);
  }
});
