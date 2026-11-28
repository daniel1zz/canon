import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { processOf } from "../claims/liveness.ts";
import { heavyRun } from "./heavy-run.ts";
import { passHeavyStep } from "./heavy-step.ts";
import { machineLoad, passLoadGate, type LoadDeps } from "./load-gate.ts";
import { throughCanon } from "./heavy-hook.ts";
import { runAsCheck } from "../claims/as-hook.ts";
import { CoordDb } from "../db.ts";

// reason: each case starts git or canon processes; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(config: string) {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}${config}`);
  if (config !== "") { sh(root, "add", "-A"); sh(root, "commit", "-qm", "heavy config"); }
  return root;
}
function cli(cwd: string, machine: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1", CANON_MACHINE: machine, ...env } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** The hook's answer for a Bash command at the given machine load: the refusal reason, or undefined when it lets the command through. */
function hook(root: string, command: string, machine: string): string | undefined {
  const before = process.env["CANON_MACHINE"];
  process.env["CANON_MACHINE"] = machine;
  try {
    const out = runAsCheck(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command } }), root, "claude");
    return out === "" ? undefined : (JSON.parse(out) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
  } finally {
    if (before === undefined) delete process.env["CANON_MACHINE"]; else process.env["CANON_MACHINE"] = before;
  }
}
const refusals = (root: string) => {
  const path = CoordDb.pathFor(root);
  if (!path.ok) return [];
  const db = CoordDb.open(path.value, root);
  if (!db.ok) throw new Error(db.error.message);
  return db.value.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'heavy.refuse' ORDER BY id").all().map((r) => JSON.parse(r.detail) as Record<string, unknown>);
};
const CONFIG = 'heavy_commands: ["godot .*--export", "scripts/record\\\\.sh"]\n';

describe("the Bash hook refuses a heavy command that did not come through canon heavy run", () => {
  test("BR-2631: while the load is at the limit a matching command is refused with the load, the limit, the way to run it and a heavy.refuse event; canon heavy run is let through", () => {
    const root = fixture(CONFIG);
    const why = hook(root, "scripts/record.sh level1", "normal,17,8");
    expect(why).toContain("heavy command while 5-minute load is 17.0 on 8 CPUs (limit 16)");
    expect(why).toContain("canon heavy run -- scripts/record.sh level1");
    expect(refusals(root)).toMatchObject([{ matched: "scripts/record\\.sh", load: 17, limit: 16, cpus: 8 }]);
    expect(hook(root, "canon heavy run -- scripts/record.sh level1", "normal,17,8")).toBeUndefined();
    expect(hook(root, "CI=1 canon heavy run -- godot --export x", "normal,17,8")).toBeUndefined();
    expect(hook(root, "  FLAG=\"a b\" X=1 canon heavy run -- godot --export x", "normal,17,8")).toBeUndefined();
  });

  test("BR-2631: a matching command is let through when BR-2630 would let it start at once, and when the load cannot be read", () => {
    const root = fixture(CONFIG);
    expect(hook(root, "scripts/record.sh level1", "normal,12,8")).toBeUndefined();
    expect(hook(root, "scripts/record.sh level1", "normal,none,8")).toBeUndefined();
    expect(refusals(root)).toEqual([]);
  });

  test("BR-2665 BR-2631: the hook judges the load by heavy_max_load_per_cpu, not delegate_max_load_per_cpu: 1000 for delegating still refuses at 17 on 8 CPUs, and heavy_max_load_per_cpu 3 lets it through", () => {
    const delegating = fixture(`${CONFIG}delegate_max_load_per_cpu: 1000\n`);
    expect(hook(delegating, "scripts/record.sh level1", "normal,17,8")).toContain("(limit 16)");
    expect(refusals(delegating)).toMatchObject([{ limit: 16 }]);
    const heavy = fixture(`${CONFIG}heavy_max_load_per_cpu: 3\n`);
    expect(hook(heavy, "scripts/record.sh level1", "normal,17,8")).toBeUndefined();
    expect(hook(heavy, "scripts/record.sh level1", "normal,24,8")).toContain("(limit 24)");
  });

  test("BR-2665: heavy_max_load_per_cpu that is not a number above 0 is a configuration error with exit 2 naming the key", () => {
    for (const value of ["0", "-1", '"high"']) {
      const r = cli(fixture(`heavy_max_load_per_cpu: ${value}\n`), "normal,1,8", ["work", "due"]);
      expect([value, r.code, r.text.includes("heavy_max_load_per_cpu")]).toEqual([value, 2, true]);
    }
  });

  test("BR-2631: a command that matches nothing is let through at any load, and without heavy_commands the hook stops nothing", () => {
    const root = fixture(CONFIG);
    expect(hook(root, "bun test", "normal,30,8")).toBeUndefined();
    const plain = fixture("");
    expect(hook(plain, "godot --headless --export x", "normal,30,8")).toBeUndefined();
  });

  test("BR-2631: a compound command is refused and the hint says to put it in sh -c", () => {
    const root = fixture(CONFIG);
    const why = hook(root, "cd game && godot --headless --export x", "normal,17,8");
    expect(why).toContain("sh -c");
    expect(why).toContain("canon heavy run -- cd game && godot --headless --export x");
  });

  test("BR-2631 BR-2630: with a heavy step waiting for the load the command is refused with how many wait, even at a low load", () => {
    const root = fixture(CONFIG);
    // a queue file of this very process stands for a canon work test that waits
    const me = processOf(process.pid)!;
    const dir = join(process.env["CANON_MACHINE_DIR"]!, "load-waits");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const file = join(dir, "000000000001-1.json");
    writeFileSync(file, JSON.stringify({ seq: 1, pid: me.pid, pidStart: me.start, subject: "C-9", worktree: "/wt/C-9", kind: "test", limit: 16, queuedAt: Date.now() }));
    try {
      const why = hook(root, "scripts/record.sh level1", "normal,12,8");
      expect(why).toContain("1 heavy step(s) wait for the load");
      expect(refusals(root)).toMatchObject([{ matched: "scripts/record\\.sh", ahead: 1 }]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("BR-2631: the command is let through when it starts with canon heavy run after blanks and NAME=value words, and not when canon heavy run only appears later", () => {
    expect(throughCanon("canon heavy run -- x")).toBe(true);
    expect(throughCanon("  A=1 B='x y' canon heavy run x")).toBe(true);
    expect(throughCanon("cd x && canon heavy run -- y")).toBe(false);
    expect(throughCanon("canon heavy runner")).toBe(false);
    expect(throughCanon("canon work test")).toBe(false);
  });

  test("BR-2631: heavy_commands that is not a list of strings, or has an item that is not a regular expression, is a configuration error with exit 2 naming the item", () => {
    for (const [config, text] of [['heavy_commands: ["("]\n', "item 1"], ['heavy_commands: ["ok", 3]\n', "list of regular expressions"], ['heavy_commands: "godot"\n', "list of regular expressions"]] as const) {
      const root = fixture(config);
      const r = cli(root, "normal,1,8", ["work", "due"]);
      expect([config, r.code, r.text.includes("heavy_commands"), r.text.includes(text)]).toEqual([config, 2, true, true]);
    }
  });
});

describe("canon heavy run waits for the load and runs the command", () => {
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "canon-heavy-")); roots.push(d); return d; };
  function loadWorld(d: string) {
    const w = { now: 5_000_000, load: 17 };
    const deps: LoadDeps = { dir: d, pollMs: 50, intervalMs: 60_000, quietMs: 300_000, now: () => w.now, self: () => processOf(process.pid)!, gone: () => false, sleep: async (ms) => { w.now += ms; await Bun.sleep(1); }, read: () => ({ load5: w.load, cpus: 8 }) };
    return { w, deps };
  }

  test("BR-2631 BR-2630: under the limit it runs the command at once; its output and exit code are the command's", async () => {
    const root = fixture("");
    const { w, deps } = loadWorld(dir());
    w.load = 12;
    const said: string[] = [];
    const out = join(root, "out.txt");
    const r = await heavyRun(ws(root, "agent:s1"), ["sh", "-c", `echo "$CANON_HEAVY_STEP" > ${out}; exit 3`], (l) => said.push(l), { load: deps, cwd: root });
    expect(r).toEqual({ ok: true, value: 3 });
    expect(readFileSync(out, "utf8").trim()).toBe("1");
    expect(said).toEqual([]);
  });

  test("BR-2631 BR-2630: over the limit it says the load line, does not run the command until the load falls, and records load.wait and load.start under the change", async () => {
    const root = fixture("");
    const { w, deps } = loadWorld(dir());
    const said: string[] = [];
    const marker = join(root, "ran.txt");
    const pending = heavyRun(ws(root, "agent:s1"), ["sh", "-c", `touch ${marker}`], (l) => said.push(l), { load: deps, cwd: root });
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
    expect(said[0]).toContain("canon: waiting for the machine load: 5-minute load 17.0 on 8 CPUs (limit 16)");
    w.load = 10;
    expect(await pending).toEqual({ ok: true, value: 0 });
    expect(existsSync(marker)).toBe(true);
    const kinds = ws(root, "agent:s1").db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind LIKE 'load.%' ORDER BY id").all();
    expect(kinds.map((k) => k.kind)).toEqual(["load.wait", "load.start"]);
    expect(JSON.parse(kinds[0]!.detail)).toMatchObject({ kind: "heavy-run" });
  });

  test("BR-2630 BR-2631: inside a heavy step (CANON_HEAVY_STEP=1) a heavy step does not pass the gate again", async () => {
    const root = fixture("");
    const { deps } = loadWorld(dir());
    const r = await passHeavyStep(ws(root, "agent:s1"), { kind: "heavy-run", subject: "C-9", worktree: root, say: () => {}, deps }, { CANON_HEAVY_STEP: "1" });
    expect(r).toEqual({ ok: true, value: "go" });
    expect(deps.dir).toBeDefined();
    // the same step at a load over the limit waits when it is not nested
    const waiting = passLoadGate({ ...deps, pollMs: 10 }, { kind: "heavy-run", subject: "C-9", worktree: root, perCpu: 2, say: () => {}, aborted: () => true, record: () => {} });
    expect(await waiting).toEqual({ ok: true, value: "aborted" });
  });

  test("BR-2631: no command is a usage error with exit 2; false ends with 1, true with 0", () => {
    const root = fixture("");
    expect(cli(root, "normal,1,8", ["heavy", "run"]).code).toBe(2);
    expect(cli(root, "normal,1,8", ["heavy", "run", "--"]).code).toBe(2);
    expect(cli(root, "normal,1,8", ["heavy", "run", "--", "false"]).code).toBe(1);
    expect(cli(root, "normal,1,8", ["heavy", "run", "--", "true"]).code).toBe(0);
    expect(cli(root, "normal,1,8", ["heavy", "run", "--", "sh", "-c", "echo hi; exit 7"])).toEqual({ code: 7, text: "hi\n" });
  });

  test("BR-2631: a SIGTERM to canon heavy run ends the command and the processes it started, and canon exits with 143", async () => {
    const root = fixture("");
    const pidfile = join(root, "child.pid");
    const proc = Bun.spawn(["bun", CLI, "heavy", "run", "--", "sh", "-c", `sleep 100 & echo $! > ${pidfile}; wait`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:s1", CANON_MACHINE: "normal,1,8" } });
    for (let i = 0; i < 200 && !existsSync(pidfile); i++) await Bun.sleep(50);
    expect(existsSync(pidfile)).toBe(true);
    const sleeper = Number(readFileSync(pidfile, "utf8").trim());
    process.kill(proc.pid, "SIGTERM");
    expect(await proc.exited).toBe(143);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(sleeper, 0); await Bun.sleep(50); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  test("BR-2630: the machine's own load queue lives under CANON_MACHINE_DIR/load-waits", () => {
    expect(machineLoad.dir).toBe(join(process.env["CANON_MACHINE_DIR"]!, "load-waits"));
  });
});
