import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { ask } from "../humans/questions.ts";
import { agenda, folded, type Readings } from "./agenda.ts";

// reason: each case reads the change states of a real repository; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

const CALM: Readings = () => ({ memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 1, cpus: 8 } });
const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n";
const change = (n: number, extra = "") => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: open\nrules: []\n${extra}---\n${BODY}`;
const gate = 'owner_gate: "看录像确认"\n';

/** main with the chain C-1163 ← C-1060 ← C-1070 ← C-1071 (C-1163 gated), and `more` changes (number → front matter). */
function chain(more: Record<number, string> = {}): string {
  const root = project(); roots.push(root);
  const files: Record<string, string> = {
    "product.md": "# Product\n\nx\n",
    "changes/C-1163.md": change(1163, gate),
    "changes/C-1060.md": change(1060, "depends_on: [C-1163]\n"),
    "changes/C-1070.md": change(1070, "depends_on: [C-1060]\n"),
    "changes/C-1071.md": change(1071, "depends_on: [C-1070]\n"),
    ...Object.fromEntries(Object.entries(more).map(([n, extra]) => [`changes/C-${n}.md`, change(Number(n), extra)])),
  };
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(root, "canon", p, ".."), { recursive: true }); writeFileSync(join(root, "canon", p), text); }
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return root;
}
function read(root: string) {
  const w = ws(root, "agent:s1");
  try { const a = agenda(w, { read: CALM }); if (!a.ok) throw new Error(a.error.message); return a.value; } finally { w.db.close(); }
}

test("BR-2635 BR-2527: an owner-gate item whose change three others wait on names them nearest first, moves to the second tier and goes before one that holds nothing", () => {
  const root = chain({ 5: gate });
  const a = read(root);
  const held = a.judge.find((i) => i.key === "owner-gate:C-1163")!;
  expect(held.tier).toBe(1);
  expect(held.holds).toEqual(["C-1060", "C-1070", "C-1071"]);
  expect(held.summary).toEndWith("; holds 3 waiting change(s): C-1060, C-1070, C-1071");
  const plain = a.judge.find((i) => i.key === "owner-gate:C-5")!;
  expect(plain.tier).toBe(2);
  expect(plain.holds).toBeUndefined();
  expect(a.judge.indexOf(held)).toBeLessThan(a.judge.indexOf(plain));
});

test("BR-2635: an item that holds changes is never folded with others of its kind; the others still fold", () => {
  const root = chain({ 5: gate, 6: gate });
  const groups = folded(read(root).judge.filter((i) => i.kind === "owner-gate"));
  expect(groups.map((g) => g.map((i) => i.key))).toEqual([["owner-gate:C-1163"], ["owner-gate:C-5", "owner-gate:C-6"]]);
});

test("BR-2635: within a tier the item holding more goes first; a landed change no longer counts as held", () => {
  const root = chain({ 5: gate, 6: "depends_on: [C-5]\n" });
  let a = read(root);
  expect(a.judge.filter((i) => i.holds).map((i) => i.key)).toEqual(["owner-gate:C-1163", "owner-gate:C-5"]);
  writeFileSync(join(root, "canon/changes/C-1060.md"), change(1060, "depends_on: [C-1163]\n").replace("status: open", "status: done"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "C-1060 done");
  a = read(root);
  expect(a.judge.find((i) => i.key === "owner-gate:C-1163")!.holds).toBeUndefined();
});

test("BR-2635: a question asked about a change that holds others stays in the owner group and says what it holds", () => {
  const root = chain();
  const w = ws(root, "agent:s1");
  const q = ask(w.db, "agent:s1", "C-1163", "A7 转给 C-1070？", ["是", "否"]);
  w.db.close();
  const item = read(root).owner.find((i) => i.key === `question:${q}`)!;
  expect(item.holds).toEqual(["C-1060", "C-1070", "C-1071"]);
  expect(item.group).toBe("owner");
});

test("BR-2635: owner-gate's start is its change's first event; with no event it stays -", () => {
  const root = chain();
  expect(read(root).judge.find((i) => i.key === "owner-gate:C-1163")!.since).toBeNull();
  const w = ws(root, "agent:s1");
  w.db.event("agent:s1", "work.start", "C-1163", {});
  w.db.close();
  expect(read(root).judge.find((i) => i.key === "owner-gate:C-1163")!.since).not.toBeNull();
});
