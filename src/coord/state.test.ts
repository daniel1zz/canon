import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addColumns, CoordDb } from "./db.ts";
import { answer, ask, enqueue, finishEntry, questions, QUEUE_STALE_MS, tryTurn } from "./state.ts";

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
