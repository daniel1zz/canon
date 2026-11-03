import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addColumns, CoordDb } from "./db.ts";
import { isGone, processOf, selfProcess, sessionProcess, type Proc } from "./liveness.ts";
import { answer, ask, claims, enqueue, finishEntry, holdClaim, questions, QUEUE_STALE_MS, renewClaim, takeClaim, tryTurn, unholdClaim } from "./state.ts";

/** A real process that is gone by the time this returns: a pid and start time the probe will find missing. */
async function deadProcess(): Promise<Proc> {
  const p = Bun.spawn(["sleep", "30"]);
  const proc = processOf(p.pid);
  if (!proc) throw new Error("no start time for a live child");
  p.kill("SIGKILL");
  await p.exited;
  return proc;
}

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-next-state-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("landing queue", () => {
  test("BR-2020: landings take turns in arrival order", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, b)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, a)).toEqual({ mine: true, ahead: 0 });
    expect(tryTurn(d, b).mine).toBe(false); // a is landing
    finishEntry(d, a, "landed", "sha");
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2044: a lander that stopped heart-beating is skipped", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    const old = new Date(Date.now() - QUEUE_STALE_MS - 1000).toISOString();
    d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(old, a);
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2044: the stale time comes from lander_stale_minutes: 11 minutes of silence is not stale at 30", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, a, 30 * 60_000).mine).toBe(true);
    d.db.query("UPDATE queue SET heartbeat = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), a);
    expect(tryTurn(d, b, 30 * 60_000)).toEqual({ mine: false, ahead: 1 });
    expect(tryTurn(d, b, 10 * 60_000)).toEqual({ mine: true, ahead: 0 });
  });
});

describe("human questions", () => {
  test("BR-2021: an agent answers only as a relay of the human's words, recorded as such; a bare agent answer is refused and recorded", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", ["yes", "no"]);
    const r = answer(d, q, "yes", "agent:x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid");
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(d.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'human.answer.refuse'").get()?.n).toBe(1);
    expect(answer(d, q, "yes", "human:dz", "x").ok).toBe(false); // a human answers directly, not as a relay
    expect(answer(d, q, "yes", "agent:x", "  好的  ").ok).toBe(true);
    const got = questions(d, "all")[0]!;
    expect([got.answer, got.answered_by, got.relayed]).toEqual(["yes", "agent:x", "好的"]);
  });

  test("BR-2040: two answers racing for one question cannot both succeed", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", ["yes", "no"]);
    // The first writer wins inside the transaction; the second sees the answer and is refused.
    const first = answer(d, q, "no", "human:a");
    const second = answer(d, q, "yes", "human:b");
    expect([first.ok, second.ok]).toEqual([true, false]);
    if (!second.ok) expect(second.error.code).toBe("conflict");
    expect(questions(d, "all")[0]!.answer).toBe("no");
  });

  test("BR-2040: a question is answered once and the answer records who gave it", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship on Friday?", ["yes", "no"]);
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(answer(d, q, "no", "human:dz").ok).toBe(true);
    const again = answer(d, q, "yes", "human:dz");
    expect(again.ok).toBe(false);
    expect(questions(d, "pending")).toEqual([]);
    expect(questions(d, "all")[0]?.answered_by).toBe("human:dz");
  });
});

describe("schema upgrades", () => {
  test("BR-2078: an old DB gains the new columns, keeps its rows, and a second opener that finds them already added still succeeds", () => {
    const path = join(mkdtempSync(join(tmpdir(), "canon-old-db-")), "state.db");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, asked_by TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', answer TEXT, answered_by TEXT, asked_at TEXT NOT NULL, answered_at TEXT)");
    old.exec("INSERT INTO questions(asked_by, question, asked_at) VALUES ('agent:a', 'Old question?', '2026-01-01')");
    old.close();
    const a = CoordDb.open(path);
    const b = CoordDb.open(path); // the race's loser: the column exists by the time its ALTER runs
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const cols = a.value.db.query<{ name: string }, []>("PRAGMA table_info(questions)").all().map((c) => c.name);
    expect(cols.filter((c) => c === "relayed")).toEqual(["relayed"]);
    expect(questions(b.value, "all").map((q) => q.question)).toEqual(["Old question?"]);
    expect(() => addColumns(a.value.db)).not.toThrow();
  });
});

describe("process liveness", () => {
  test("BR-2098: an entry ahead whose lander process is gone is abandoned at once, though its heartbeat is fresh", async () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x", await deadProcess());
    const b = enqueue(d, "/wt/b", "C-2", "x", selfProcess());
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
    expect(d.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(a)?.state).toBe("abandoned");
  });

  test("BR-2098: a lander whose process runs is waited for; a reused pid with another start time is not", async () => {
    const d = db();
    const live = enqueue(d, "/wt/a", "C-1", "x", selfProcess());
    const b = enqueue(d, "/wt/b", "C-2", "x", selfProcess());
    expect(tryTurn(d, live).mine).toBe(true);
    expect(tryTurn(d, b)).toEqual({ mine: false, ahead: 1 });
    d.db.query("UPDATE queue SET pid_start = ? WHERE id = ?").run("Thu Jan  1 00:00:00 1970", live);
    expect(tryTurn(d, b)).toEqual({ mine: true, ahead: 0 });
  });

  test("BR-2098: an entry without a recorded process is judged by its heartbeat alone", () => {
    const d = db();
    const a = enqueue(d, "/wt/a", "C-1", "x");
    const b = enqueue(d, "/wt/b", "C-2", "x");
    expect(tryTurn(d, a).mine).toBe(true);
    expect(tryTurn(d, b)).toEqual({ mine: false, ahead: 1 });
  });

  test("BR-2100: a live claim whose session process is gone is taken over by another actor at once", async () => {
    const d = db();
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * 3600_000, await deadProcess()).ok).toBe(true);
    const b = takeClaim(d, "C-1", "/wt/C-1", "agent:b", 12 * 3600_000, selfProcess());
    expect(b.ok).toBe(true);
    expect(claims(d).map((c) => c.actor)).toEqual(["agent:b"]);
  });

  test("BR-2100: a claim whose session process runs, or that recorded none, holds for its lease", () => {
    const d = db();
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * 3600_000, selfProcess());
    takeClaim(d, "C-2", "/wt/C-2", "agent:a");
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b").ok).toBe(false);
    expect(takeClaim(d, "C-2", "/wt/C-2", "agent:b").ok).toBe(false);
  });

  test("BR-2100: the holder's later work commands move the claim to its current session process", async () => {
    const d = db();
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * 3600_000, await deadProcess());
    renewClaim(d, "/wt/C-1", "agent:a", 12 * 3600_000, selfProcess()); // the session was resumed under a new process
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b").ok).toBe(false);
  });

  test("BR-2100: a session in another time zone reads the same start time, so a running holder stays running", () => {
    const here = selfProcess()!;
    const probe = `import { processStart } from ${JSON.stringify(join(import.meta.dir, "liveness.ts"))}; console.log(processStart(${here.pid}))`;
    for (const tz of ["Pacific/Kiritimati", "America/Adak"]) {
      const r = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", env: { ...process.env, TZ: tz } });
      expect(r.stdout.toString().trim()).toBe(here.start);
    }
  });

  test("BR-2100: a start time recorded in local time before the switch to UTC still names the running process", () => {
    const d = db();
    const local = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe", env: { ...process.env, LC_ALL: "C" } }).stdout.toString().trim().replace(/\s+/g, " ");
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * 3600_000, { pid: process.pid, start: local });
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b").ok).toBe(false);
  });

  test("BR-2100: a table that cannot be read on the local-zone retry proves nothing", () => {
    const p = { pid: 4242, start: "Tue Nov  3 11:49:43 2026" };
    const reads = (utc: string | null | undefined, local: string | null | undefined) => (_: number, zone: "utc" | "local") => (zone === "utc" ? utc : local);
    expect(isGone(p, reads("Tue Nov  3 03:49:43 2026", undefined))).toBeUndefined();
    expect(isGone(p, reads("Tue Nov  3 03:49:43 2026", "Tue Nov  3 11:49:43 2026"))).toBe(false);
    expect(isGone(p, reads("Wed Nov  4 01:00:00 2026", "Wed Nov  4 09:00:00 2026"))).toBe(true); // pid reused
    expect(isGone(p, reads(null, undefined))).toBe(true);
  });

  test("BR-2100: CLAUDE_PID is believed only inside Claude Code and only when it is an ancestor of this process", () => {
    const parent = process.ppid;
    expect(sessionProcess({ CLAUDECODE: "1", CLAUDE_PID: String(parent) })?.pid).toBe(parent);
    expect(sessionProcess({ CLAUDE_PID: String(parent) })).toBeUndefined();
    const child = Bun.spawn(["sleep", "5"]);
    try {
      expect(sessionProcess({ CLAUDECODE: "1", CLAUDE_PID: String(child.pid) })).toBeUndefined(); // alive, but not an ancestor
    } finally {
      child.kill();
    }
  });
});

describe("holds while a worktree is removed", () => {
  test("BR-2019: a hold refuses a start of the same change even by the same actor at the same path, and unhold removes only the hold", () => {
    const d = db();
    const h = holdClaim(d, "C-1", "/wt/C-1", "human:x", true);
    if (!h.ok) throw new Error(h.error.message);
    const same = takeClaim(d, "C-1", "/wt/C-1", "human:x");
    expect(!same.ok && same.error.code).toBe("conflict");
    unholdClaim(d, h.value);
    expect(claims(d)).toEqual([]);
    expect(takeClaim(d, "C-1", "/wt/C-1", "human:x").ok).toBe(true);
    unholdClaim(d, h.value); // a real claim is never taken for a hold
    expect(claims(d).map((c) => c.holder)).toEqual(["/wt/C-1"]);
  });

  test("BR-2064: a hold cannot be taken over by another clean or drop of the same actor, so ending one never ends the other", () => {
    const d = db();
    const cleaning = holdClaim(d, "C-1", "/wt/C-1", "human:x", true);
    if (!cleaning.ok) throw new Error(cleaning.error.message);
    const dropping = holdClaim(d, "C-1", "/wt/C-1", "human:x", false);
    expect(!dropping.ok && dropping.error.code).toBe("conflict");
    expect(holdClaim(d, "C-1", "/wt/C-1", "human:x", true).ok).toBe(false);
    unholdClaim(d, { ...cleaning.value, mark: `${cleaning.value.mark}x` }); // some other hold's end
    expect(claims(d).length).toBe(1);
  });

  test("BR-2100: a hold left by a clean or drop that was killed frees as soon as its process is gone", async () => {
    const d = db();
    expect(holdClaim(d, "C-1", "/wt/C-1", "agent:a", false).ok).toBe(true);
    expect(d.db.query<{ pid: number }, []>("SELECT pid FROM claims").get()?.pid).toBe(process.pid);
    const dead = await deadProcess();
    d.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = 'C-1'").run(dead.pid, dead.start);
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b").ok).toBe(true);
    expect(claims(d).map((c) => c.actor)).toEqual(["agent:b"]);
  });
});
