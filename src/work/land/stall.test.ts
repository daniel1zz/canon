import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { refusalsInARow } from "./stall.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const SUB = "agent:s1:w1";
const MAIN_SESSION = "agent:s1";

function canon(cwd: string, actor: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor, CLAUDECODE: actor.startsWith("agent:") ? "1" : "" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project with a change started by `actor`; `dirty()` leaves an uncommitted file so the next landing is refused as dirty. */
function started(actor: string) {
  const root = project();
  const s = startNew(root, "Work", actor);
  const dirty = () => writeFileSync(join(s.worktree, "scratch.txt"), `${Math.random()}\n`);
  const clean = () => {
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "scratch");
  };
  const refusals = (reason: string) => ws(root, actor).db.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM events WHERE subject = ? AND kind = 'land.refuse' AND json_extract(detail, '$.reason') = ?").get(s.change, reason)!.n;
  return { root, s, dirty, clean, refusals };
}

describe("a subagent's change refused three times in a row (BR-2454)", () => {
  test("BR-2454: the third refusal says to stop and report; the fourth landing does not queue, is refused as stalled listing the three even with uncommitted changes, and stalled refusals do not count", async () => {
    const t = started(SUB);
    const outs = [];
    for (let i = 0; i < 3; i++) {
      t.dirty();
      outs.push(await land(ws(t.s.worktree, SUB), FAST, quiet));
    }
    expect(outs.map((o) => o.kind === "refused" && o.reason)).toEqual(["dirty", "dirty", "dirty"]);
    expect(outs[1]!.kind === "refused" && outs[1]!.message).not.toContain("canon work unstall");
    expect(outs[2]!.kind === "refused" && outs[2]!.message).toContain(`${t.s.change} has been refused 3 times in a row: stop and report to the main agent`);
    expect(outs[2]!.kind === "refused" && outs[2]!.message).toContain(`canon work unstall ${t.s.change} --reason`);
    t.clean();
    for (let i = 0; i < 2; i++) {
      const fourth = await land(ws(t.s.worktree, SUB), FAST, quiet);
      expect(fourth.kind === "refused" && fourth.reason).toBe("stalled");
      expect(fourth.kind === "refused" && fourth.message).toContain("refused 3 times in a row, so it does not queue");
      expect(fourth.kind === "refused" && (fourth.message.match(/ dirty\n/g) ?? []).length).toBe(3);
    }
    t.dirty();
    const dirtyToo = await land(ws(t.s.worktree, SUB), FAST, quiet);
    expect(dirtyToo.kind === "refused" && dirtyToo.reason).toBe("stalled");
    expect(t.refusals("stalled")).toBe(3);
    expect(refusalsInARow(ws(t.root, SUB).db, t.s.change)).toHaveLength(3);
    // reason: nothing queued for the stalled landings, so the queue holds no entry of this change
    expect(ws(t.root, SUB).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'land.start'").get()!.n).toBe(3);
  }, 60_000);

  test("BR-2454: refusals for the machine, queue timeouts, races or setup do not count, a repeat refusal does, a landing resets the count, and the main session is never stopped", async () => {
    const t = started(SUB);
    const db = ws(t.root, SUB).db;
    for (const reason of ["conflict", "environment", "timeout", "main-moved", "check"]) db.event(SUB, "land.refuse", t.s.change, { reason });
    db.event(SUB, "land.refuse", t.s.change, { reason: "check", repeat_of: 1 });
    expect(refusalsInARow(db, t.s.change).map((r) => r.reason)).toEqual(["conflict", "check", "check"]);
    db.event(SUB, "land.ok", t.s.change, {});
    db.event(SUB, "land.refuse", t.s.change, { reason: "evidence" });
    expect(refusalsInARow(db, t.s.change).map((r) => r.reason)).toEqual(["evidence"]);

    const m = started(MAIN_SESSION);
    for (let i = 0; i < 3; i++) {
      m.dirty();
      const out = await land(ws(m.s.worktree, MAIN_SESSION), FAST, quiet);
      expect(out.kind === "refused" && out.message).not.toContain("canon work unstall");
    }
    m.dirty();
    const fourth = await land(ws(m.s.worktree, MAIN_SESSION), FAST, quiet);
    expect(fourth.kind === "refused" && fourth.reason).toBe("dirty");
    expect(m.refusals("stalled")).toBe(0);
  }, 60_000);
});

describe("canon work unstall (BR-2455)", () => {
  test("BR-2455: the main session or a person lets a stopped change land again; a subagent, too few refusals, no reason or an unknown change are refused", async () => {
    const t = started(SUB);
    const db = ws(t.root, SUB).db;
    for (let i = 0; i < 2; i++) db.event(SUB, "land.refuse", t.s.change, { reason: "conflict" });
    const few = canon(t.root, MAIN_SESSION, "work", "unstall", t.s.change, "--reason", "x");
    expect([few.code, few.err.includes("2 refusal(s) in a row")]).toEqual([1, true]);
    db.event(SUB, "land.refuse", t.s.change, { reason: "conflict" });
    expect(canon(t.root, MAIN_SESSION, "work", "unstall", t.s.change).code).toBe(2);
    expect(canon(t.root, MAIN_SESSION, "work", "unstall", "x-1", "--reason", "x").code).toBe(2);
    const self = canon(t.root, SUB, "work", "unstall", t.s.change, "--reason", "x");
    expect([self.code, self.err.includes("only the main session or a person")]).toEqual([1, true]);
    expect(canon(t.root, MAIN_SESSION, "work", "unstall", "C-999", "--reason", "x").code).toBe(3);
    expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'land.unstall'").get()!.n).toBe(0);
    const done = canon(t.root, MAIN_SESSION, "work", "unstall", t.s.change, "--reason", "split the conflicting files off");
    expect([done.code, done.out.trim()]).toEqual([0, `${t.s.change} may land again; its count of refusals in a row starts from zero`]);
    const ev = db.db.query<{ detail: string; actor: string }, []>("SELECT detail, actor FROM events WHERE kind = 'land.unstall'").get()!;
    expect([JSON.parse(ev.detail), ev.actor]).toEqual([{ reason: "split the conflicting files off", refusals: 3 }, MAIN_SESSION]);
    expect(refusalsInARow(db, t.s.change)).toEqual([]);
    const person = started(SUB);
    for (let i = 0; i < 3; i++) ws(person.root, SUB).db.event(SUB, "land.refuse", person.s.change, { reason: "dirty" });
    expect(canon(person.root, "human:owner", "work", "unstall", person.s.change, "--reason", "ok").code).toBe(0);
    t.dirty();
    const again = await land(ws(t.s.worktree, SUB), FAST, quiet);
    expect(again.kind === "refused" && again.reason).toBe("dirty");
  }, 60_000);

  test("BR-2455: a chore identity is a valid work identity, not a usage error", () => {
    const t = started(SUB);
    const unknown = canon(t.root, MAIN_SESSION, "work", "unstall", "chore-7a4d2f1e-9b3c-4d5e-8f6a-0b1c2d3e4f5a", "--reason", "x");
    expect(unknown.code).toBe(3);
    expect(canon(t.root, MAIN_SESSION, "work", "unstall", "chore-abc", "--reason", "x").code).toBe(2);
  }, 30_000);
});
