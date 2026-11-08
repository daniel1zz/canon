import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueue, finishEntry, tryTurn, joinBatch, lockBatch, landBatched } from "./queue.ts";
import { recordFailure } from "../../watch/redmain.ts";
import { priorityNow } from "./wait.ts";
import { mark, marks } from "./urgent.ts";
import { project, sh, startNew, ws } from "../../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "invocation", "main.ts");

/** Runs the canon CLI as an agent outside Claude Code (the entry point and its exit codes). */
function canon(cwd: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
  delete env["CLAUDECODE"];
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string; actor: string; detail: string }, [string]>("SELECT subject, actor, detail FROM events WHERE kind = ? ORDER BY id").all(kind);

describe("the owner's priority in the coordination DB", () => {
  test("BR-2363: a marked change takes the next turn ahead of earlier entries, after the fix change and before the backlog's urgent list", () => {
    const root = project();
    const d = ws(root).db;
    const [c1, c2, c3, c4] = ["C-1", "C-2", "C-3", "C-4"].map((s) => enqueue(d, `/wt/${s}`, s, "x"));
    // nobody marked: queue order (BR-2232)
    expect(tryTurn(d, c2!, undefined, priorityNow(ws(root)))).toEqual({ mine: false, ahead: 1 });
    mark(d, "agent:a", "C-2", "C-2 先合");
    // marked: the very next try is C-2's turn, nothing waited for a landing
    expect(tryTurn(d, c1!, undefined, priorityNow(ws(root))).mine).toBe(false);
    expect(tryTurn(d, c2!, undefined, priorityNow(ws(root)))).toEqual({ mine: true, ahead: 0 });
    // the order of all four: fix change, marked, backlog list, rest
    const p = { fix: "C-4", marked: new Set(["C-2"]), urgent: new Set(["C-3"]) };
    finishEntry(d, c2!, "landed", "sha");
    expect(tryTurn(d, c1!, undefined, p).ahead).toBe(2); // C-4 and C-3 are ahead of C-1
    expect(tryTurn(d, c3!, undefined, p).ahead).toBe(1); // only the fix change
    expect(tryTurn(d, c4!, undefined, p).mine).toBe(true);
  });

  test("BR-2363: a marked change ranks above one the backlog lists, and below the fix change", () => {
    const root = project();
    const d = ws(root).db;
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const c = enqueue(d, "/wt/c", "C-3", "x");
    mark(d, "agent:a", "C-2", "go");
    recordFailure(d, { sha: "a".repeat(40), log: "/x.log", tail: "boom", green: null });
    d.db.query("UPDATE red_main SET change = 'C-3' WHERE id = 1").run();
    const p = priorityNow(ws(root));
    expect([p.fix, [...(p.marked ?? [])]]).toEqual(["C-3", ["C-2"]]);
    expect(tryTurn(d, b, undefined, p)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, a, undefined, p)).toEqual({ mine: false, ahead: 2 });
    expect(tryTurn(d, c, undefined, p).mine).toBe(true);
  });

  test("BR-2363: a running landing is not interrupted by a change marked meanwhile", () => {
    const root = project();
    const d = ws(root).db;
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, a, undefined, priorityNow(ws(root))).mine).toBe(true);
    mark(d, "agent:a", "C-2", "go");
    expect(tryTurn(d, b, undefined, priorityNow(ws(root)))).toEqual({ mine: false, ahead: 1 });
  });

  test("BR-2363: the mark is deleted when the change lands, alone or in a batch", () => {
    const d = ws(project()).db;
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const c = enqueue(d, "/wt/c", "C-3", "x");
    for (const s of ["C-1", "C-2", "C-3"]) mark(d, "agent:a", s, "go");
    finishEntry(d, a, "landed", "sha");
    expect(marks(d).map((m) => m.change)).toEqual(["C-2", "C-3"]);
    expect(tryTurn(d, b).mine).toBe(true);
    joinBatch(d, b, c, "head");
    lockBatch(d, b, [c]);
    landBatched(d, c, "sha");
    expect(marks(d).map((m) => m.change)).toEqual(["C-2"]);
    finishEntry(d, b, "failed", "floor"); // a refused landing keeps its mark: the change still has to land
    expect(marks(d).map((m) => m.change)).toEqual(["C-2"]);
  });

  test("BR-2363: with no mark the order is BR-2232's", () => {
    const root = project();
    const p = priorityNow(ws(root));
    expect([...(p.marked ?? [])]).toEqual([]);
    const d = ws(root).db;
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, b, undefined, p)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, a, undefined, p).mine).toBe(true);
  });

  test("BR-2363: the command marks an open change at once, a second mark updates the words, --clear removes it, clearing an unmarked change is exit 3, a landed change is exit 2", () => {
    const root = project();
    const s = startNew(root, "Fast one");
    const got = canon(root, "backlog", "urgent", s.change, "--relayed", "先合这个");
    expect(got.code).toBe(0);
    expect(marks(ws(root).db).map((m) => [m.change, m.words])).toEqual([[s.change, "先合这个"]]);
    expect(canon(root, "backlog", "urgent", s.change, "--relayed", "还是它").code).toBe(0);
    expect(marks(ws(root).db).map((m) => m.words)).toEqual(["还是它"]);
    expect(canon(root, "backlog", "urgent", s.change, "--clear", "--relayed", "不用了").code).toBe(0);
    expect(marks(ws(root).db)).toEqual([]);
    expect(canon(root, "backlog", "urgent", s.change, "--clear", "--relayed", "不用了").code).toBe(3);
    // a name that is not a change is refused, nothing recorded
    expect(canon(root, "backlog", "urgent", "C-999", "--relayed", "x").code).not.toBe(0);
    expect(marks(ws(root).db)).toEqual([]);
  });

  test("BR-2363: a change that is done on main cannot be marked: exit 2, nothing recorded", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-50.md"), "---\nid: C-50\ntitle: Old one\nstatus: done\nrules: []\n---\n\n## 为什么\n\nx.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "a done change");
    const r = canon(root, "backlog", "urgent", "C-50", "--relayed", "x");
    expect([r.code, marks(ws(root).db)]).toEqual([2, []]);
    expect(r.out).toContain("is done");
    // a mark left on a change that is no longer open can still be cleared
    mark(ws(root).db, "agent:a", "C-50", "go");
    expect(canon(root, "backlog", "urgent", "C-50", "--clear", "--relayed", "撤销").code).toBe(0);
    expect(marks(ws(root).db)).toEqual([]);
  });

  test("BR-2364: a mark or a clear without the owner's words is exit 2 and recorded; with them it is recorded with the words and the relaying actor", () => {
    const root = project();
    const s = startNew(root, "Words needed");
    for (const args of [[], ["--relayed", "  "]]) {
      expect(canon(root, "backlog", "urgent", s.change, ...args).code).toBe(2);
    }
    expect(marks(ws(root).db)).toEqual([]);
    expect(events(root, "urgent.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["no-relayed", "no-relayed"]);
    expect(canon(root, "backlog", "urgent", s.change, "--relayed", "C 先合").code).toBe(0);
    const set = events(root, "urgent.set");
    expect([set[0]!.subject, set[0]!.actor, JSON.parse(set[0]!.detail).relayed]).toEqual([s.change, "agent:a", "C 先合"]);
    expect(canon(root, "backlog", "urgent", s.change, "--clear").code).toBe(2);
    expect(marks(ws(root).db)).toHaveLength(1);
    expect(canon(root, "backlog", "urgent", s.change, "--clear", "--relayed", "撤销").code).toBe(0);
    expect(JSON.parse(events(root, "urgent.clear")[0]!.detail).relayed).toBe("撤销");
  });

  test("BR-2364: the command's help and canon brief say agents use it only when the owner asked", () => {
    const root = project();
    expect(canon(root, "backlog", "urgent", "--help").out).toContain("ONLY when the owner asked");
    expect(canon(root, "brief").out).toContain("canon backlog urgent");
  });

  test("BR-2365: canon work status lists the marks, in text and in --json, and nothing when there are none", () => {
    const root = project();
    const s = startNew(root, "Listed one");
    const none = JSON.parse(canon(root, "work", "status", "--json").out);
    expect(none.urgent).toEqual([]);
    expect(canon(root, "work", "status").out).not.toContain("Urgent by the owner:");
    expect(canon(root, "backlog", "urgent", s.change, "--relayed", "C 先合").code).toBe(0);
    const some = JSON.parse(canon(root, "work", "status", "--json").out);
    expect(some.urgent.map((m: { change: string; words: string }) => [m.change, m.words])).toEqual([[s.change, "C 先合"]]);
    expect(canon(root, "work", "status").out).toContain("Urgent by the owner:");
    expect(canon(root, "work", "status").out).toContain(`${s.change}  relayed by agent:a`);
    const d = ws(root).db;
    const e = enqueue(d, "/wt/x", s.change, "x");
    finishEntry(d, e, "landed", "sha");
    expect(JSON.parse(canon(root, "work", "status", "--json").out).urgent).toEqual([]);
  });
});
