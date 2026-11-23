import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { CONFIGURABLE_CHECKS, check, checkNotes, type CheckPolicy } from "./check.ts";
import { readConfig } from "../../invocation/config.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { land } from "../../work/land/land.ts";

// reason: the landing case lands for real; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

// Fixture ids are assembled at runtime, so only test titles name rules (BR-2005).
const README = "---\ncode: [src/billing]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n";
const br = (n: number) => ["BR", n].join("-");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });

/** A tree with one planned rule that has no example: a rule-no-example finding by default. */
function noExample(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-policy-")); roots.push(root);
  const files = { "canon/rules/billing/README.md": README, [`canon/rules/billing/${br(1)}.md`]: `---\nid: ${br(1)}\ntitle: Rule 1\nstatus: planned\n---\n## 规则\n\nStatement.\n\n## 例子\n\n\n` };
  mkdirSync(join(root, "src/billing"), { recursive: true });
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  return root;
}
/** Takes the filled ## 教训 that startNew writes out of the change file and commits it. */
function dropLessons(wt: string): void {
  const dir = join(wt, "canon/changes");
  const file = join(dir, readdirSync(dir)[0]!);
  writeFileSync(file, readFileSync(file, "utf8").replace("## 教训\n\n无。\n\n", ""));
  sh(wt, "add", "-A"); sh(wt, "commit", "-qm", "no lessons");
}
const kinds = (fs: readonly { rule: string }[]) => fs.map((f) => f.rule);
const policy = (over: Partial<CheckPolicy>): CheckPolicy => ({ ...CONFIGURABLE_CHECKS, ...over });

test("BR-2641: rule-no-example is a finding by default, a note when set to remind and nothing when off", () => {
  const root = noExample();
  const input = { root, ...readCorpus(root), testFiles: [] };
  expect(kinds(check(input))).toContain("rule-no-example");
  expect(kinds(checkNotes(input))).not.toContain("rule-no-example");
  const remind = { ...input, checkPolicy: policy({ "rule-no-example": "remind" }) };
  expect(kinds(check(remind))).not.toContain("rule-no-example");
  expect(kinds(checkNotes(remind))).toContain("rule-no-example");
  const off = { ...input, checkPolicy: policy({ "rule-no-example": "off" }) };
  expect(kinds(check(off))).not.toContain("rule-no-example");
  expect(kinds(checkNotes(off))).not.toContain("rule-no-example");
});

test("BR-2641: a reminder set to refuse becomes a finding: decision-options", () => {
  const root = noExample();
  writeFileSync(join(root, "canon/rules/billing", `${br(1)}.md`), `---\nid: ${br(1)}\ntitle: Rule 1\nstatus: planned\n---\n## 规则\n\nStatement.\n\n## 例子\n\n- a → b\n`);
  mkdirSync(join(root, "canon/decisions"), { recursive: true });
  writeFileSync(join(root, "canon/decisions/D-1.md"), "---\nid: D-1\ntitle: One way\nstatus: accepted\n---\n\n## 背景\n\nx\n\n## 方案\n\n1. Only this：采用。\n\n## 决定\n\nx\n\n## 后果\n\nx\n");
  const input = { root, ...readCorpus(root), testFiles: [] };
  expect(kinds(check(input))).not.toContain("decision-options");
  expect(kinds(checkNotes(input))).toContain("decision-options");
  expect(kinds(check({ ...input, checkPolicy: policy({ "decision-options": "refuse" }) }))).toContain("decision-options");
});

test("BR-2641 BR-2638: a check that says a document is false cannot be set: ref-dangling in policies.checks is a configuration error", () => {
  const root = mkdtempSync(join(tmpdir(), "canon-policy-")); roots.push(root);
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/config.yaml"), "policies:\n  checks:\n    ref-dangling: remind\n");
  const r = readConfig(root);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.message).toContain("unknown entry `policies.checks.ref-dangling`");
});

test("BR-2641 BR-2074: a landing judges by main's policies.checks, so a branch that relaxes a check for its own rule is still refused", async () => {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "product");
  const s = startNew(root, "Relax", "agent:s1");
  appendFileSync(join(s.worktree, "canon/config.yaml"), "policies:\n  checks:\n    rule-no-example: remind\n");
  const dir = join(s.worktree, "canon/rules/x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${br(1)}.md`), `---\nid: ${br(1)}\ntitle: Rule 1\nstatus: planned\nbusiness: x\n---\n\n## 规则\n\nStatement.\n\n## 例子\n\n\n`);
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "relax and add");
  const r = await land(ws(s.worktree, "agent:s1"), FAST, quiet);
  expect(r.kind).toBe("refused");
  if (r.kind === "refused") expect((r.findings ?? []).map((f) => f.rule)).toContain("rule-no-example");
});

test("BR-2641 BR-2161: with main's policies.checks.lessons set to remind, --finish closes a change without lessons and says so in a note; the branch's own setting counts for nothing", async () => {
  const root = project(); roots.push(root);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  appendFileSync(join(root, "canon/config.yaml"), "policies:\n  checks:\n    lessons: remind\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "lessons remind");
  const s = startNew(root, "No lessons", "agent:s1");
  dropLessons(s.worktree);
  const said: string[] = [];
  const r = await land(ws(s.worktree, "agent:s1"), { ...FAST, finish: true }, (l: string) => said.push(l));
  expect(r).toMatchObject({ kind: "landed", finished: true });
  expect(said.some((l) => l.startsWith("note: ") && l.includes("policies.checks.lessons is remind"))).toBe(true);
  // the default on main refuses, whatever a branch writes for itself
  const strict = project(); roots.push(strict);
  writeFileSync(join(strict, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(strict, "add", "-A"); sh(strict, "commit", "-qm", "product");
  const t = startNew(strict, "Relax lessons", "agent:s1");
  dropLessons(t.worktree);
  appendFileSync(join(t.worktree, "canon/config.yaml"), "policies:\n  checks:\n    lessons: \"off\"\n");
  sh(t.worktree, "add", "-A"); sh(t.worktree, "commit", "-qm", "off for me");
  expect(await land(ws(t.worktree, "agent:s1"), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "lessons" });
});
