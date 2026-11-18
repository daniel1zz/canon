import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryNow, type MemorySources } from "../../kernel/machine.ts";
import type { Corpus } from "../../knowledge/documents/model.ts";
import { project, sh, startNew, ws } from "../testkit.ts";
import { measure, readings, refusal } from "./capacity.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const env = (machine: string, actor = "agent:s1") => ({ ...process.env, CANON_ACTOR: actor, CANON_MACHINE: machine });
function cli(cwd: string, machine: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env(machine) });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
const CALM = "normal,1,8";
/** A project with `n` open changes started by agent:s1, optionally with delegate_max_workers set. */
function fixture(n: number, maxWorkers?: number) {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  if (maxWorkers !== undefined) appendFileSync(join(root, "canon/config.yaml"), `delegate_max_workers: ${maxWorkers}\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  const changes = Array.from({ length: n }, (_, i) => startNew(root, `Work ${i}`, "agent:s1").change);
  return { root, changes };
}
const events = (root: string, kind: string) => { const w = ws(root); try { return w.db.db.query<{ subject: string; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ subject: r.subject, detail: JSON.parse(r.detail) })); } finally { w.db.close(); } };
const delegated = (root: string) => { const w = ws(root); try { return w.db.db.query<{ subject: string }, []>("SELECT subject FROM delegations WHERE ended IS NULL ORDER BY subject").all().map((r) => r.subject); } finally { w.db.close(); } };

const sources = (over: Partial<MemorySources>): MemorySources => ({ platform: "linux", sysctl: () => undefined, file: () => undefined, ...over });

test("BR-2526: memory pressure comes from macOS's pressure level, Linux PSI, or Linux MemAvailable; anything else is not measured", () => {
  const mac = (level: string | undefined) => memoryNow(sources({ platform: "darwin", sysctl: (n) => (n === "kern.memorystatus_vm_pressure_level" ? level : undefined) }));
  expect(mac("1")).toEqual({ tight: false, text: "memory pressure normal" });
  expect(mac("2")).toEqual({ tight: true, text: "memory pressure warn" });
  expect(mac("4")).toEqual({ tight: true, text: "memory pressure critical" });
  expect(mac("0")).toBeUndefined();
  expect(mac(undefined)).toBeUndefined();
  const psi = (avg10: string) => memoryNow(sources({ file: (p) => (p === "/proc/pressure/memory" ? `some avg10=${avg10} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n` : "MemTotal: 100 kB\nMemAvailable: 1 kB\n") }));
  expect(psi("9.99")?.tight).toBe(false);
  expect(psi("10.00")?.tight).toBe(true);
  const meminfo = (available: number) => memoryNow(sources({ file: (p) => (p === "/proc/meminfo" ? `MemTotal:       1000 kB\nMemFree:  5 kB\nMemAvailable:   ${available} kB\n` : undefined) }));
  expect(meminfo(80)).toEqual({ tight: true, text: "MemAvailable 8% of MemTotal, limit 10%" });
  expect(meminfo(100)?.tight).toBe(false);
  expect(memoryNow(sources({}))).toBeUndefined();
  expect(memoryNow(sources({ platform: "win32" }))).toBeUndefined();
});

test("BR-2526: CANON_MACHINE replaces the readings, and a malformed value fails loudly", () => {
  expect(readings({ CANON_MACHINE: "warn,16,8" })).toEqual({ memory: { tight: true, text: "memory pressure warn" }, machine: { load5: 16, cpus: 8 } });
  expect(readings({ CANON_MACHINE: "none,none,8" })).toEqual({ memory: undefined, machine: undefined });
  expect(() => readings({ CANON_MACHINE: "busy" })).toThrow("CANON_MACHINE");
});

test("BR-2526: a new worker under memory pressure is refused with exit 1, a delegation.refuse event and no delegation", () => {
  const f = fixture(1);
  const r = cli(f.root, "warn,1,8", "work", "delegate", f.changes[0]!, "--to", "w1");
  expect(r.code).toBe(1);
  expect(r.text).toContain("memory pressure warn");
  expect(delegated(f.root)).toEqual([]);
  const [e] = events(f.root, "delegation.refuse");
  expect(e).toMatchObject({ subject: f.changes[0], detail: { reason: "capacity", memory: "memory pressure warn", load: 1, cpus: 8 } });
});

test("BR-2526: the load limit is delegate_max_load_per_cpu times the CPUs, compared unrounded", () => {
  const f = fixture(2);
  const over = cli(f.root, "normal,16,8", "work", "delegate", f.changes[0]!, "--to", "w1");
  expect(over.code).toBe(1);
  expect(over.text).toContain("5-minute load 16.0 on 8 CPUs (limit 16)");
  expect(cli(f.root, "normal,15.96,8", "work", "delegate", f.changes[1]!, "--to", "w2").code).toBe(0);
});

test("BR-2526: delegations beyond delegate_max_workers are refused; a redelegation is never checked", () => {
  const f = fixture(2, 1);
  expect(cli(f.root, CALM, "work", "delegate", f.changes[0]!, "--to", "w1").code).toBe(0);
  const full = cli(f.root, CALM, "work", "delegate", f.changes[1]!, "--to", "w2");
  expect(full.code).toBe(1);
  expect(full.text).toContain("1 of delegate_max_workers (1) in use");
  const again = cli(f.root, "critical,99,8", "work", "delegate", f.changes[0]!, "--to", "w3");
  expect(again.code).toBe(0);
  expect(delegated(f.root)).toEqual([f.changes[0]!]);
});

test("BR-2526: two sessions delegating at once never both take the last slot", async () => {
  const f = fixture(2, 1);
  const run = (change: string, name: string) => Bun.spawn(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "delegate", change, "--to", name], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env(CALM) });
  const procs = [run(f.changes[0]!, "w1"), run(f.changes[1]!, "w2")];
  const codes = (await Promise.all(procs.map((p) => p.exited))).sort();
  expect(codes).toEqual([0, 1]);
  expect(delegated(f.root)).toHaveLength(1);
});

test("BR-2526: an unmeasured signal is skipped, said in one line each, and recorded in delegation.create", () => {
  const f = fixture(1);
  const r = cli(f.root, "none,none,8", "work", "delegate", f.changes[0]!, "--to", "w1");
  expect(r.code).toBe(0);
  expect(r.text).toContain("capacity: memory not measured on this platform; delegated without that check");
  expect(r.text).toContain("capacity: load not measured on this platform; delegated without that check");
  expect(events(f.root, "delegation.create")[0]!.detail.unmeasured).toEqual(["memory", "load"]);
});

test("BR-2526: a delegation whose change is closed on main, or that is stalled, holds no slot", () => {
  const f = fixture(0);
  const w = ws(f.root);
  try {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (const s of ["C-90", "C-91", "C-92"]) w.db.db.query("INSERT INTO delegations(subject,worker,owner,revision,epoch,manifest,task_hash) VALUES (?,?,?,?,?,?,?)").run(s, "w", "agent:s1", "x", 1, "[]", "h");
    w.db.db.query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?,?,?,?,?)").run(old, "agent:s1", "delegation.create", "C-91", "{}");
    const corpus = { docs: [{ id: "C-90", kind: "change", status: "done" }, { id: "C-92", kind: "change", status: "open" }] } as unknown as Corpus;
    const cap = measure(w, corpus, () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } }));
    expect(cap.ok && [...cap.value.free].sort()).toEqual(["C-90", "C-91"]);
    expect(cap.ok && refusal({ ...w, config: { ...w.config, delegateMaxWorkers: 2 } } as typeof w, cap.value)).toBeUndefined();
    expect(cap.ok && refusal({ ...w, config: { ...w.config, delegateMaxWorkers: 1 } } as typeof w, cap.value)?.reasons).toEqual(["1 of delegate_max_workers (1) in use"]);
  } finally {
    w.db.close();
  }
});
