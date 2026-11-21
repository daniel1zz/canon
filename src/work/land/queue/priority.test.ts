import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUrgent } from "../../../knowledge/documents/backlog.ts";
import { selfProcess } from "../../claims/liveness.ts";
import { recordFailure } from "../../watch/redmain.ts";
import { priorityNow } from "./wait.ts";
import { batchCandidates, enqueue, finishEntry, rankOf, tryTurn } from "./queue.ts";
import { project, sh, startNew, ws } from "../../testkit.ts";

// reason: the BR-2605 cases spawn canon several times; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

describe("what jumps the landing queue", () => {
  test("BR-2232: only the items under 优先合入 count, up to the next heading of the same or a higher level", () => {
    const text = "# 待办顺序\n\n1. C-1 first\n\n## 优先合入\n\n- C-2 now\n- [ ] `C-4` too\n\n### 说明\n\n- C-5 still in the section\n\n## 其他\n\n- C-3 later\n";
    expect([...parseUrgent(text)].sort()).toEqual(["C-2", "C-4", "C-5"]);
    expect([...parseUrgent("1. C-1\n2. C-2\n")]).toEqual([]);
  });

  test("BR-2232: the urgent list is read from main; a change editing its own backlog does not jump", () => {
    const root = project();
    const s = startNew(root, "Self promote");
    writeFileSync(join(s.worktree, "canon/backlog.md"), "## 优先合入\n\n- C-1\n");
    sh(s.worktree, "add", "canon/backlog.md");
    sh(s.worktree, "commit", "-qm", "promote myself");
    expect([...priorityNow(ws(s.worktree)).urgent]).toEqual([]);

    writeFileSync(join(root, "canon/backlog.md"), "## 优先合入\n\n- C-1\n");
    sh(root, "add", "canon/backlog.md");
    sh(root, "commit", "-qm", "owner marks C-1 urgent");
    expect([...priorityNow(ws(s.worktree)).urgent]).toEqual(["C-1"]);
  });

  test("BR-2232: the fix change recorded for a failing main is the first priority", () => {
    const root = project();
    const w = ws(root);
    expect(priorityNow(w).fix).toBeUndefined();
    recordFailure(w.db, { sha: "a".repeat(40), log: "/x.log", tail: "boom", green: null, files: [], reported: false });
    w.db.db.query("UPDATE red_main SET change = 'C-7' WHERE id = 1").run();
    expect(priorityNow(w).fix).toBe("C-7");
  });

  test("BR-2232: a change that is the fix change and also listed urgent or marked counts once, at its highest rank, above a marked and a listed change", () => {
    const p = { fix: "C-1", marked: new Set(["C-1", "C-2"]), urgent: new Set(["C-1", "C-3"]) };
    expect([rankOf("C-1", p), rankOf("C-2", p), rankOf("C-3", p), rankOf("C-4", p), rankOf(null, p)]).toEqual([3, 2, 1, 0, 0]);
  });
});

const MAIN = join(import.meta.dir, "..", "..", "..", "invocation", "main.ts");
/** `canon priority set` through the real entry point, as the main session (BR-2602). */
function setTier(root: string, change: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:s1" };
  delete env["CLAUDECODE"];
  const r = Bun.spawnSync(["bun", MAIN, "priority", "set", change, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  expect({ change, args, code: r.exitCode, err: r.stderr.toString() }).toEqual({ change, args, code: 0, err: "" });
}
/** A project whose main has open C-1 to C-9. */
function changesRepo(): string {
  const root = project();
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  for (let n = 1; n <= 9; n++) writeFileSync(join(root, `canon/changes/C-${n}.md`), `---\nid: C-${n}\ntitle: Change ${n}\nstatus: open\nrules: []\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "changes");
  return root;
}
/** The order the waiting entries take their turns in, as each lander asks at its next try (tiers reread every time). */
function turnOrder(root: string, entries: Record<string, number>): string[] {
  const out: string[] = [];
  const left = new Map(Object.entries(entries));
  const d = ws(root).db;
  while (left.size > 0) {
    const next = [...left].find(([, id]) => tryTurn(d, id, undefined, priorityNow(ws(root))).mine);
    if (!next) throw new Error(`no entry takes the turn among ${[...left.keys()].join(", ")}`);
    out.push(next[0]);
    finishEntry(d, next[1], "landed", "sha");
    left.delete(next[0]);
  }
  return out;
}

describe("BR-2605: waiting landings by tier first, the old order within a tier", () => {
  test("BR-2605: a main agent's P1 lands first, then P2, then P3; with no tier the queue order stands", () => {
    const root = changesRepo();
    const d = ws(root).db;
    const plain = { "C-1": enqueue(d, "/wt/1", "C-1", "x"), "C-2": enqueue(d, "/wt/2", "C-2", "x"), "C-3": enqueue(d, "/wt/3", "C-3", "x") };
    expect(turnOrder(root, plain)).toEqual(["C-1", "C-2", "C-3"]);
    const entries = { "C-1": enqueue(d, "/wt/1", "C-1", "x"), "C-2": enqueue(d, "/wt/2", "C-2", "x"), "C-3": enqueue(d, "/wt/3", "C-3", "x") };
    setTier(root, "C-2", "P3", "--reason", "有空再合");
    setTier(root, "C-3", "P1", "--reason", "阻塞别人");
    expect(turnOrder(root, entries)).toEqual(["C-3", "C-1", "C-2"]);
  });

  test("BR-2605: the fix of a failing main goes before the owner's P0; backlog urgent is the owner's P1 and ranks only within P1", () => {
    const root = changesRepo();
    const w = ws(root);
    recordFailure(w.db, { sha: "a".repeat(40), log: "/x.log", tail: "boom", green: null });
    w.db.db.query("UPDATE red_main SET change = 'C-9' WHERE id = 1").run();
    const d = w.db;
    const entries = { "C-1": enqueue(d, "/wt/1", "C-1", "x"), "C-2": enqueue(d, "/wt/2", "C-2", "x"), "C-3": enqueue(d, "/wt/3", "C-3", "x"), "C-4": enqueue(d, "/wt/4", "C-4", "x"), "C-9": enqueue(d, "/wt/9", "C-9", "x") };
    setTier(root, "C-4", "P0", "--relayed", "最急");
    setTier(root, "C-1", "P1", "--reason", "x");
    const urgent = Bun.spawnSync(["bun", MAIN, "backlog", "urgent", "C-2", "--relayed", "先合"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:s1" } });
    expect(urgent.exitCode).toBe(0);
    // C-2 is the owner's P1 (backlog urgent): within P1 it is ahead of the main agent's P1 C-1, and behind both P0s
    expect(turnOrder(root, entries)).toEqual(["C-9", "C-4", "C-2", "C-1", "C-3"]);
  });

  test("BR-2605: within a tier the 优先合入 section of the backlog on main still goes first", () => {
    const root = changesRepo();
    writeFileSync(join(root, "canon/backlog.md"), "## 优先合入\n\n- C-5\n");
    sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner lists C-5");
    const d = ws(root).db;
    const entries = { "C-6": enqueue(d, "/wt/6", "C-6", "x"), "C-5": enqueue(d, "/wt/5", "C-5", "x"), "C-7": enqueue(d, "/wt/7", "C-7", "x") };
    setTier(root, "C-7", "P3", "--reason", "x");
    expect(turnOrder(root, entries)).toEqual(["C-5", "C-6", "C-7"]);
  });

  test("BR-2605: a tier set while a landing is under way does not interrupt it; it counts at the next turn", () => {
    const root = changesRepo();
    const d = ws(root).db;
    const a = enqueue(d, "/wt/1", "C-1", "x");
    const b = enqueue(d, "/wt/2", "C-2", "x");
    const c = enqueue(d, "/wt/3", "C-3", "x");
    expect(tryTurn(d, a, undefined, priorityNow(ws(root))).mine).toBe(true);
    setTier(root, "C-3", "P1", "--reason", "x");
    expect(tryTurn(d, c, undefined, priorityNow(ws(root)))).toEqual({ mine: false, ahead: 1 }); // only C-1, landing
    expect(tryTurn(d, b, undefined, priorityNow(ws(root)))).toEqual({ mine: false, ahead: 2 });
    finishEntry(d, a, "landed", "sha");
    expect(tryTurn(d, c, undefined, priorityNow(ws(root))).mine).toBe(true);
  });

  test("BR-2605: batch members are taken in the same order, a higher tier first; a chore is P2", () => {
    const root = changesRepo();
    const d = ws(root).db;
    const lead = enqueue(d, "/wt/l", "C-1", "x", selfProcess());
    expect(tryTurn(d, lead, undefined, priorityNow(ws(root))).mine).toBe(true);
    const chore = enqueue(d, "/wt/ch", "chore-tidy", "x", selfProcess());
    const m2 = enqueue(d, "/wt/m2", "C-2", "x", selfProcess());
    const m3 = enqueue(d, "/wt/m3", "C-3", "x", selfProcess());
    setTier(root, "C-3", "P1", "--reason", "x");
    setTier(root, "C-2", "P3", "--reason", "x");
    expect(batchCandidates(d, lead, 3, undefined, priorityNow(ws(root))).map((c) => c.id)).toEqual([m3, chore, m2]);
  });
});
