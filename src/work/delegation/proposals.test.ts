import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { check } from "../../knowledge/check/check.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";

// reason: each case spawns canon and lands; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(120_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
/** A process that certainly is not running: this pid with a start time it never had. */
const GONE = { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" };
const RULE = "canon/rules/billing/BR-1.md";
const ruleText = (example: string) => `---\nid: BR-1\ntitle: Refunds\nstatus: active\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nRefunds are answered.\n\n## 例子\n\n${example}\n`;

/** BR-1 on main (an example line holding →), a change delegated by agent:s1 to w1 and claimed by agent:s7:w1. */
function fixture() {
  const root = project(); roots.push(root);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/a.ts"), "export {};\n");
  writeFileSync(join(root, RULE), ruleText("- A → B"));
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nFirst design.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "rule");
  const s = startNew(root, "Worker task", "agent:s1");
  expect(cli(root, "agent:s1", "work", "delegate", s.change, "--to", "w1").code).toBe(0);
  expect(cli(root, "agent:s7:w1", "work", "start", s.change).code).toBe(0);
  return { root, ...s };
}
function workerGone(root: string, change: string) {
  const w = ws(root);
  try { w.db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(GONE.pid, GONE.start, change); } finally { w.db.close(); }
}

test("BR-2524 BR-2501 BR-2499: a worker proposes a rule's whole text, lands it without a design refusal, names it in its design request; the design owner applies it word for word after take", () => {
  const f = fixture();
  const proposed = cli(f.worktree, "agent:s7:w1", "rule", "propose", "BR-1");
  expect(proposed.code).toBe(0);
  const path = join(f.worktree, `canon/proposals/${f.change}/BR-1.md`);
  const copy = readFileSync(path, "utf8");
  expect(copy).toMatch(/^---\nproposed_from: [0-9a-f]{40}\nid: BR-1\n/);
  expect(cli(f.worktree, "agent:s7:w1", "rule", "propose", "BR-1").code).toBe(5); // already proposed
  // the issue's case: an example that itself holds →, changed from A → B to A → C
  writeFileSync(path, copy.replace("- A → B", "- A → C"));
  sh(f.worktree, "add", "-A"); sh(f.worktree, "commit", "-qm", "propose BR-1");
  const landed = cli(f.worktree, "agent:s7:w1", "work", "land");
  expect(landed.text).not.toContain("changed the design");
  expect(landed.code === 0 ? "" : landed.text).toBe("");
  expect(cli(f.worktree, "agent:s7:w1", "rule", "apply", f.change).code).toBe(1); // a worker never applies
  const asked = cli(f.worktree, "agent:s7:w1", "work", "need-design", f.change, "BR-1's example must change");
  expect(asked.code).toBe(0);
  const w = ws(f.root);
  try {
    expect(w.db.db.query<{ request: string }, []>("SELECT request FROM design_requests ORDER BY id DESC LIMIT 1").get()!.request).toContain(`canon/proposals/${f.change}/BR-1.md`);
  } finally { w.db.close(); }
  expect(cli(f.worktree, "agent:s1", "rule", "apply", f.change).code).toBe(1); // still delegated: take it back first
  workerGone(f.root, f.change);
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(0);
  const applied = cli(f.worktree, "agent:s1", "rule", "apply", f.change);
  expect(applied.code).toBe(0);
  expect(applied.text).toContain("+- A → C");
  expect(readFileSync(join(f.worktree, RULE), "utf8")).toBe(ruleText("- A → C"));
  expect(existsSync(path)).toBe(false);
});

test("BR-2524: a proposal whose rule changed on main since it was copied refuses the whole apply with exit 5 and writes nothing", () => {
  const f = fixture();
  expect(cli(f.worktree, "agent:s7:w1", "rule", "propose", "BR-1").code).toBe(0);
  const path = join(f.worktree, `canon/proposals/${f.change}/BR-1.md`);
  writeFileSync(path, readFileSync(path, "utf8").replace("- A → B", "- A → C"));
  sh(f.worktree, "add", "-A"); sh(f.worktree, "commit", "-qm", "propose");
  // main moves BR-1 meanwhile
  const other = startNew(f.root, "Other edit", "agent:s2");
  writeFileSync(join(other.worktree, RULE), ruleText("- A → D"));
  sh(other.worktree, "commit", "-qam", "edit BR-1");
  sh(f.root, "merge", "-q", "--ff-only", sh(other.worktree, "rev-parse", "HEAD"));
  workerGone(f.root, f.change);
  expect(cli(f.root, "agent:s1", "work", "take", f.change, "--from", "w1").code).toBe(0);
  const r = cli(f.worktree, "agent:s1", "rule", "apply", f.change);
  expect(r.code).toBe(5);
  expect(r.text).toContain("BR-1 changed on main since proposed");
  expect(readFileSync(join(f.worktree, RULE), "utf8")).toBe(ruleText("- A → B"));
  expect(existsSync(path)).toBe(true);
});

test("BR-2525: canon check reports proposals left under a change that is not open; an open change's proposals are fine", () => {
  const root = project(); roots.push(root);
  const change = (status: string) => `---\nid: C-1\ntitle: x\nstatus: ${status}\nrules: []\n---\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  mkdirSync(join(root, "canon/proposals/C-1"), { recursive: true });
  writeFileSync(join(root, "canon/proposals/C-1/BR-1.md"), "---\nproposed_from: 0\nid: BR-1\n---\n");
  const findings = (status: string) => {
    writeFileSync(join(root, "canon/changes/C-1.md"), change(status));
    return check({ root, ...readCorpus(root), testFiles: [] }).filter((x) => x.rule === "proposal-unapplied").map((x) => `${x.path}: ${x.message}`);
  };
  expect(findings("open")).toEqual([]);
  expect(findings("done")).toEqual(["canon/proposals/C-1: C-1 is done but still has rule proposals not applied: BR-1; its design owner applies them (canon rule apply C-1) or deletes them"]);
});
