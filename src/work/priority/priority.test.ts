import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { recordFailure } from "../watch/redmain.ts";
import { enqueue, finishEntry } from "../land/queue/queue.ts";
import { project, sh, ws } from "../testkit.ts";

// reason: every case spawns canon several times; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
/** The real entry point, as the given actor outside Claude Code. */
function cli(cwd: string, actor: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor };
  delete env["CLAUDECODE"];
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const MAIN_AGENT = "agent:s1";
const WORKER = "agent:s1:w1";

const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n";
const change = (n: number, status: string) => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: []\n---\n${BODY}`;

/** A project whose main has open C-5 to C-9, landed C-3 and dropped C-4. */
function repo(): string {
  const root = project(); roots.push(root);
  const files: Record<string, string> = { "C-3.md": change(3, "done"), "C-4.md": change(4, "dropped") };
  for (const n of [5, 6, 7, 8, 9]) files[`C-${n}.md`] = change(n, "open");
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  for (const [p, text] of Object.entries(files)) writeFileSync(join(root, "canon/changes", p), text);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "changes");
  return root;
}
function db<T>(root: string, f: (d: CoordDb) => T): T { const w = ws(root); try { return f(w.db); } finally { w.db.close(); } }
const events = (root: string, kind: string) => db(root, (d) => d.db.query<{ subject: string; actor: string; detail: string }, [string]>("SELECT subject, actor, detail FROM events WHERE kind = ? ORDER BY id").all(kind)).map((e) => ({ ...e, detail: JSON.parse(e.detail) as Record<string, unknown> }));
const rows = (root: string) => db(root, (d) => d.db.query<{ change: string; tier: string; set_by: string }, []>("SELECT change, tier, set_by FROM priorities ORDER BY change").all());
/** C-9 is the fix change of a failing main (BR-2221). */
const fixMain = (root: string, change = "C-9") => db(root, (d) => { recordFailure(d, { sha: "a".repeat(40), log: "/x.log", tail: "boom", green: null, files: [], reported: true }); d.db.query("UPDATE red_main SET change = ? WHERE id = 1").run(change); });

describe("BR-2602: canon priority set", () => {
  test("BR-2602: the main session sets P1 to P3 with a reason; the owner's words set P0 to P3; each success records priority.set", () => {
    const root = repo();
    const a = cli(root, MAIN_AGENT, "priority", "set", "C-5", "P1", "--reason", "阻塞 C-7");
    expect(a).toMatchObject({ code: 0, out: "C-5: P1 (by the main agent: 阻塞 C-7)\n" });
    expect(rows(root)).toEqual([{ change: "C-5", tier: "P1", set_by: "main-agent" }]);
    const set = events(root, "priority.set");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ subject: "C-5", actor: MAIN_AGENT, detail: { tier: "P1", previous: "P2", by: "main-agent", reason: "阻塞 C-7" } });

    const b = cli(root, MAIN_AGENT, "priority", "set", "C-5", "P0", "--relayed", "这个最急");
    expect(b).toMatchObject({ code: 0, out: "C-5: P0 (by the owner: 这个最急)\n" });
    expect(rows(root)).toEqual([{ change: "C-5", tier: "P0", set_by: "owner" }]);
    expect(events(root, "priority.set")[1]).toMatchObject({ detail: { tier: "P0", previous: "P1", by: "owner", relayed: "这个最急" } });

    expect(cli(root, MAIN_AGENT, "priority", "set", "C-6", "P3", "--reason", "有空再做").code).toBe(0);
    expect(rows(root).map((r) => [r.change, r.tier])).toEqual([["C-5", "P0"], ["C-6", "P3"]]);
  });

  test("BR-2602: every refusal exits 1, leaves the tiers as they were and records priority.refuse with its reason", () => {
    const root = repo();
    fixMain(root);
    const cases: [string, string[], string][] = [
      [MAIN_AGENT, ["C-5", "P0", "--reason", "x"], "p0-owner-only"],
      [WORKER, ["C-5", "P1", "--reason", "x"], "worker"],
      [WORKER, ["C-5", "P1", "--relayed", "负责人说的"], "worker"],
      [MAIN_AGENT, ["C-9", "P1", "--reason", "x"], "fix-main"],
      [MAIN_AGENT, ["C-9", "P0", "--relayed", "x"], "fix-main"],
      [MAIN_AGENT, ["C-3", "P1", "--reason", "x"], "closed"],
      [MAIN_AGENT, ["C-4", "P1", "--relayed", "x"], "closed"],
    ];
    for (const [actor, args, reason] of cases) {
      const r = cli(root, actor, "priority", "set", ...args);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.err).toContain(reason);
    }
    expect(rows(root)).toEqual([]);
    expect(events(root, "priority.set")).toEqual([]);
    expect(events(root, "priority.refuse").map((e) => [e.subject, e.detail["reason"]])).toEqual(cases.map(([, args, reason]) => [args[0], reason]));
  });

  test("BR-2602: the main agent cannot lower or clear the owner's tier, may raise it, and the owner's tier stays as the floor", () => {
    const root = repo();
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-6", "P1", "--relayed", "C-6 要快").code).toBe(0);
    const lower = cli(root, MAIN_AGENT, "priority", "set", "C-6", "P3", "--reason", "x");
    expect(lower.code).toBe(1);
    expect(lower.err).toContain("owner-set");
    expect(lower.err).toContain("P1");
    expect(lower.err).toContain("C-6 要快");
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-6", "--clear", "--reason", "x").code).toBe(1);
    expect(rows(root)).toEqual([{ change: "C-6", tier: "P1", set_by: "owner" }]);

    // the owner set P2; the main agent raises it to P1, then cannot go below P2
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-7", "P2", "--relayed", "普通").code).toBe(0);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-7", "P1", "--reason", "阻塞别人")).toMatchObject({ code: 0, out: "C-7: P1 (by the main agent: 阻塞别人)\n" });
    expect(rows(root).find((r) => r.change === "C-7")).toEqual({ change: "C-7", tier: "P1", set_by: "main-agent" });
    const below = cli(root, MAIN_AGENT, "priority", "set", "C-7", "P3", "--reason", "x");
    expect(below.code).toBe(1);
    expect(below.err).toContain("owner-set");
    expect(below.err).toContain("P2");
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-7", "P2", "--reason", "回到负责人的").code).toBe(0);
    expect(events(root, "priority.refuse").map((e) => [e.subject, e.detail["reason"]])).toEqual([["C-6", "owner-set"], ["C-6", "owner-set"], ["C-7", "owner-set"]]);
  });

  test("BR-2602: --clear returns to P2; the main agent may clear its own tier and the owner any", () => {
    const root = repo();
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-5", "P3", "--reason", "x").code).toBe(0);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-5", "--clear", "--reason", "不用了")).toMatchObject({ code: 0, out: "C-5: P2 (cleared by the main agent: 不用了)\n" });
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-6", "P0", "--relayed", "急").code).toBe(0);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-6", "--clear", "--relayed", "不急了").code).toBe(0);
    expect(rows(root)).toEqual([]);
    expect(events(root, "priority.set").at(-1)).toMatchObject({ subject: "C-6", detail: { tier: "P2", previous: "P0", by: "owner", cleared: true, relayed: "不急了" } });
  });

  test("BR-2602: neither, both, or blank --reason and --relayed exit 2 and change nothing; so do a bad tier and a missing one", () => {
    const root = repo();
    for (const args of [["C-5", "P1"], ["C-5", "P1", "--reason", "x", "--relayed", "y"], ["C-5", "P1", "--reason", "  "], ["C-5", "P1", "--relayed", ""], ["C-5", "P5", "--reason", "x"], ["C-5", "--reason", "x"], ["C-5", "P1", "--clear", "--reason", "x"]]) {
      expect({ args, code: cli(root, MAIN_AGENT, "priority", "set", ...args).code }).toEqual({ args, code: 2 });
    }
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-99", "P1", "--reason", "x").code).toBe(3);
    expect(rows(root)).toEqual([]);
    expect(events(root, "priority.set")).toEqual([]);
  });

  test("BR-2602: canon backlog urgent is the owner's P1, a mark written before tiers existed too; a tier set later replaces it", () => {
    const root = repo();
    expect(cli(root, MAIN_AGENT, "backlog", "urgent", "C-8", "--relayed", "先合这个").code).toBe(0);
    const json = () => JSON.parse(cli(root, MAIN_AGENT, "change", "list", "--json").out) as { id: string; priority: string; priority_by: string | null }[];
    expect(json().find((c) => c.id === "C-8")).toMatchObject({ priority: "P1", priority_by: "owner" });
    expect(events(root, "priority.set").at(-1)).toMatchObject({ subject: "C-8", detail: { tier: "P1", by: "owner", relayed: "先合这个" } });
    // the main agent cannot lower the owner's P1 given through backlog urgent
    const lower = cli(root, MAIN_AGENT, "priority", "set", "C-8", "P2", "--reason", "x");
    expect(lower.code).toBe(1);
    expect(lower.err).toContain("先合这个");
    // setting the owner's own tier again changes nothing: it stays the owner's mark
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-8", "P1", "--reason", "x")).toMatchObject({ code: 0, out: "C-8: P1 (unchanged: set by the owner: 先合这个)\n" });
    expect(json().find((c) => c.id === "C-8")).toMatchObject({ priority: "P1", priority_by: "owner" });
    // a mark an older canon wrote straight into the urgent table, with no tier row, still counts as the owner's P1
    db(root, (d) => d.db.query("INSERT INTO urgent(change, words, actor, at) VALUES ('C-7', '旧的标记', 'agent:old', '2026-11-01T00:00:00.000Z')").run());
    expect(json().find((c) => c.id === "C-7")).toMatchObject({ priority: "P1", priority_by: "owner" });
    // the owner's later word replaces the mark
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-7", "P3", "--relayed", "不急").code).toBe(0);
    expect(json().find((c) => c.id === "C-7")).toMatchObject({ priority: "P3", priority_by: "owner" });
    expect(JSON.parse(cli(root, MAIN_AGENT, "work", "status", "--json").out).urgent.map((m: { change: string }) => m.change)).toEqual(["C-8"]);
  });
});

describe("BR-2603: the tier and who set it in canon change list and canon work status", () => {
  test("BR-2603: change list writes every open change's tier, and who set it when one is set; --json has priority and priority_by", () => {
    const root = repo();
    fixMain(root);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-5", "P1", "--reason", "阻塞 C-7").code).toBe(0);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-7", "P3", "--relayed", "以后再说").code).toBe(0);
    const line = (id: string) => cli(root, MAIN_AGENT, "change", "list", "--all").out.split("\n").find((l) => l.startsWith(`${id} `)) ?? "";
    expect(line("C-5")).toMatch(/^C-5 +open +P1 main agent  Change 5  \(/);
    expect(line("C-6")).toMatch(/^C-6 +open +P2 {13}Change 6  \(/);
    expect(line("C-7")).toMatch(/^C-7 +open +P3 owner {7}Change 7  \(/);
    expect(line("C-9")).toMatch(/^C-9 +open +P0 fix-main {4}Change 9  \(/);
    // a landed or dropped change shows no tier
    expect(line("C-3")).not.toMatch(/\bP[0-3]\b/);
    expect(line("C-4")).not.toMatch(/\bP[0-3]\b/);
    const json = JSON.parse(cli(root, MAIN_AGENT, "change", "list", "--all", "--json").out) as { id: string; priority: string | null; priority_by: string | null }[];
    const by = new Map(json.map((c) => [c.id, [c.priority, c.priority_by]]));
    expect(Object.fromEntries(by)).toMatchObject({ "C-3": [null, null], "C-4": [null, null], "C-5": ["P1", "main-agent"], "C-6": ["P2", null], "C-7": ["P3", "owner"], "C-9": ["P0", "fix-main"] });
  });

  test("BR-2603: work status lists each open change with a tier set under Priorities, with who, when and why; none when none is set", () => {
    const root = repo();
    expect(cli(root, MAIN_AGENT, "work", "status").out).not.toContain("Priorities:");
    expect(JSON.parse(cli(root, MAIN_AGENT, "work", "status", "--json").out).priorities).toEqual([]);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-5", "P1", "--reason", "阻塞 C-7").code).toBe(0);
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-8", "P0", "--relayed", "马上做").code).toBe(0);
    const text = cli(root, MAIN_AGENT, "work", "status").out;
    const section = text.slice(text.indexOf("Priorities:"));
    expect(section).toMatch(/C-8 +P0 by the owner at \d{4}-\d\d-\d\dT[^:]+:\d\d:[\d.]+Z: 马上做 \(relayed by agent:s1\)/);
    expect(section).toMatch(/C-5 +P1 by the main agent at \d{4}-\d\d-\d\dT\S+: 阻塞 C-7/);
    expect(section).not.toContain("C-6");
    const listed = JSON.parse(cli(root, MAIN_AGENT, "work", "status", "--json").out).priorities as { change: string; tier: string; by: string; words: string; at: string }[];
    expect(listed.map((p) => [p.change, p.tier, p.by, p.words])).toEqual([["C-8", "P0", "owner", "马上做"], ["C-5", "P1", "main-agent", "阻塞 C-7"]]);
    expect(listed.every((p) => typeof p.at === "string")).toBe(true);
  });

  test("BR-2603: a change that lands is no longer listed with its tier", () => {
    const root = repo();
    expect(cli(root, MAIN_AGENT, "priority", "set", "C-5", "P1", "--reason", "x").code).toBe(0);
    db(root, (d) => finishEntry(d, enqueue(d, "/wt/C-5", "C-5", "x"), "landed", "sha"));
    writeFileSync(join(root, "canon/changes/C-5.md"), change(5, "done"));
    sh(root, "commit", "-qam", "C-5 landed");
    expect(cli(root, MAIN_AGENT, "work", "status").out).not.toContain("Priorities:");
    const json = JSON.parse(cli(root, MAIN_AGENT, "change", "list", "--all", "--json").out) as { id: string; priority: string | null }[];
    expect(json.find((c) => c.id === "C-5")?.priority).toBeNull();
  });
});
