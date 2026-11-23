import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { project, sh, startNew, waitFor, ws } from "../testkit.ts";
import { machineDeps, workTest, type WorkTestDeps } from "./verify.ts";
import { acquireSlot, machineSlots } from "./slot.ts";
import { machineLoad } from "./load-gate.ts";
import { heavyLine } from "../reminders/agenda.ts";
import { runningFullRuns } from "../reminders/heavy.ts";

// reason: each case runs canon work test on a real repository; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });
const put = (root: string, files: Record<string, string>) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const WRAP = "f=\"$1\"; r=\"$2\"\nprintf '<testsuites><testsuite name=\"t\"></testsuite></testsuites>' > \"$r\"\necho \"$f\" >> runs.log\n";

/** A change in its worktree; with `held`, a change on main waits on it. `policies` is YAML under policies:. */
function fixture(held: boolean, policies = "") {
  const root = project(); roots.push(root);
  put(root, {
    "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "sh wrap.sh {file} {report}"\ntest_jobs: 1\n${policies ? `policies:\n${policies}` : ""}`,
    "canon/product.md": "# Product\n\nShared work.\n",
    "wrap.sh": WRAP, ".gitignore": "runs.log\n", "src/d.test.ts": "export {};\n",
  });
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  const s = startNew(root, "On the chain", "agent:s1");
  if (held) {
    put(root, { "canon/changes/C-900.md": `---\nid: C-900\ntitle: Waits\nstatus: open\nrules: []\nowner_gate: "none: t"\nadvances: "none: t"\ndepends_on: [${s.change}]\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n` });
    sh(root, "add", "-A"); sh(root, "commit", "-qm", "C-900 waits");
  }
  return { root, ...s };
}
function deps(load: number): WorkTestDeps {
  return {
    ...machineDeps, tickMs: 40, graceMs: 300, parallelism: () => 8, exit: () => {},
    signals: (() => { const e = new EventEmitter(); return { on: (s: NodeJS.Signals, f: (s: NodeJS.Signals) => void) => e.on(s, f), off: (s: NodeJS.Signals, f: (s: NodeJS.Signals) => void) => e.off(s, f) }; })(),
    slots: { ...machineSlots, dir: mkdtempSync(join(tmpdir(), "canon-slots-")), pollMs: 30, gone: () => false },
    load: { ...machineLoad, dir: mkdtempSync(join(tmpdir(), "canon-load-")), pollMs: 30, gone: () => false, read: () => ({ load5: load, cpus: 8 }) },
    lane: { ...machineSlots, dir: mkdtempSync(join(tmpdir(), "canon-lane-")), pollMs: 30, gone: () => false },
  };
}
const runs = (wt: string) => (existsSync(join(wt, "runs.log")) ? readFileSync(join(wt, "runs.log"), "utf8").trim().split("\n") : []);
const kinds = (root: string) => ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'load.%' OR kind LIKE 'test.lane.%' ORDER BY id").all().map((r) => r.kind);

test("BR-2643: named files of a change another waits on run at once over the load limit, in the lane, saying what it holds", async () => {
  const f = fixture(true);
  const lines: string[] = [];
  const r = await workTest(ws(f.worktree, "agent:s1"), false, (l) => lines.push(l), deps(24), ["src/d.test.ts"]);
  expect(r.ok).toBe(true);
  expect(runs(f.worktree)).toEqual(["src/d.test.ts"]);
  expect(lines).toContain(`canon: critical-path lane: ${f.change} holds C-900; these named files do not wait for the machine load and run one at a time on this machine (BR-2643; policies.capacity.critical_lane: false turns it off)`);
  expect(kinds(f.root)).toEqual(["test.lane.start", "test.lane.end"]);
});

test("BR-2643: one at a time: a lane run waits while another holds the lane, and starts once it is given back", async () => {
  const f = fixture(true);
  const d = deps(24);
  const other = await acquireSlot(d.lane, { subject: "C-901", worktree: "/other", kind: "work-test", max: 1, say: () => {}, aborted: () => false, record: () => {} });
  if (!other.ok || other.value === "aborted") throw new Error("could not hold the lane");
  const run = workTest(ws(f.worktree, "agent:s1"), false, () => {}, d, ["src/d.test.ts"]);
  await waitFor("the lane wait", () => kinds(f.root).includes("test.lane.wait"));
  expect(runs(f.worktree)).toEqual([]);
  other.value.release("passed");
  await run;
  expect(runs(f.worktree)).toEqual(["src/d.test.ts"]);
});

test("BR-2643 BR-2630: a change nobody waits on, a full run, and critical_lane false all wait for the load as before", async () => {
  for (const [held, policies, only] of [[false, "", ["src/d.test.ts"]], [true, "  capacity:\n    critical_lane: false\n", ["src/d.test.ts"]], [true, "", []]] as const) {
    const f = fixture(held, policies);
    const w = { load: 24 };
    const d = { ...deps(0), load: { ...deps(0).load, read: () => ({ load5: w.load, cpus: 8 }) } };
    const lines: string[] = [];
    const run = workTest(ws(f.worktree, "agent:s1"), false, (l) => lines.push(l), d, only);
    await waitFor("the load wait", () => lines.some((l) => l.includes("waiting for the machine load")));
    expect(lines.some((l) => l.includes("critical-path lane"))).toBe(false);
    w.load = 1;
    await run;
  }
});

test("BR-2643 BR-2582: the heavy line lists the lane apart, with the run in it and how many wait", () => {
  const h = { running: [], waiting: 0, loadWaiting: [], lane: { running: [{ subject: "C-1163", since: new Date(Date.now() - 2 * 60_000).toISOString() }], waiting: 1 } };
  expect(heavyLine(h, Date.now())).toBe("heavy: none running; critical lane: C-1163 2m, 1 waiting");
  const empty = mkdtempSync(join(tmpdir(), "canon-empty-"));
  const r = runningFullRuns({ dir: empty, gone: () => false }, { dir: empty, gone: () => false }, undefined, { dir: empty, gone: () => false });
  expect(r.ok && r.value.lane).toEqual({ running: [], waiting: 0 });
});
