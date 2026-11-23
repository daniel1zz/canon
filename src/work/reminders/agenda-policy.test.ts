import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { agenda, dueList, type Readings } from "./agenda.ts";
import type { Slots } from "./heavy.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const CALM: Readings = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
const slots = (): Slots => ({ dir: mkdtempSync(join(tmpdir(), "canon-machine-")), gone: () => false });
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const HOUR = 3_600_000;
function cli(cwd: string, actor: string, args: readonly string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** A project whose canon/config.yaml also has `policies` (YAML text under it, indented). */
function fresh(policies = ""): string {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  if (policies) appendFileSync(join(root, "canon/config.yaml"), `policies:\n${policies}`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  return root;
}
const items = (root: string, now = Date.now()) => dueList(must(agenda(ws(root, "agent:s1"), { read: CALM, slots: slots(), now })));

test("BR-2639 BR-2612: policies.agenda.slow_hours makes a delegated change slow after that many hours instead of 6", () => {
  const t0 = Date.now();
  for (const [policies, slowAt3h] of [["", false], ["  agenda:\n    slow_hours: 2\n", true]] as const) {
    const root = fresh(policies);
    const s = startNew(root, "Slow work", "agent:s1");
    expect(cli(root, "agent:s1", ["work", "delegate", s.change, "--to", "w1"]).code).toBe(0);
    // reason: a live worker holds it, so it is slow rather than stalled (BR-2522)
    expect(cli(root, "agent:s7:w1", ["work", "start", s.change]).code).toBe(0);
    const w = ws(root);
    w.db.db.query("UPDATE events SET ts = ? WHERE subject = ? AND kind = 'delegation.create'").run(new Date(t0).toISOString(), s.change);
    w.db.close();
    expect(items(root, t0 + 3 * HOUR).some((i) => i.key === `slow:${s.change}`)).toBe(slowAt3h);
  }
});

test("BR-2639 BR-2606: policies.agenda.interrupt_tiers decides which tiers interrupt; a P1 change does not when only P0 is listed", () => {
  for (const [policies, interrupts] of [["", true], ["  agenda:\n    interrupt_tiers: [P0]\n", false]] as const) {
    const root = fresh(policies);
    // a change on main nobody started: it can start, so a listed tier interrupts (BR-2606)
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-50.md"), "---\nid: C-50\ntitle: Urgent\nstatus: open\nrules: []\nowner_gate: \"none: test\"\nadvances: \"none: test\"\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n");
    sh(root, "add", "-A"); sh(root, "commit", "-qm", "C-50");
    expect(cli(root, "agent:s1", ["priority", "set", "C-50", "P1", "--reason", "needed soon"]).code).toBe(0);
    expect(items(root).some((i) => i.key === "interrupt:C-50")).toBe(interrupts);
  }
});

test("BR-2639 BR-2534: policies.agenda.flaky_days decides how long a flaky test stays on the agenda", () => {
  const now = Date.now();
  for (const [policies, shown] of [["", true], ["  agenda:\n    flaky_days: 3\n", false]] as const) {
    const root = fresh(policies);
    const w = ws(root);
    w.db.db.query("INSERT INTO events(ts, actor, worktree, kind, subject, detail) VALUES (?, 'canon', ?, 'floor.flaky', NULL, ?)").run(new Date(now - 4 * 24 * HOUR).toISOString(), root, JSON.stringify({ sha: "x", files: ["t/a.test.sh"] }));
    w.db.close();
    expect(items(root, now).some((i) => i.key === "flaky:t/a.test.sh")).toBe(shown);
  }
});
