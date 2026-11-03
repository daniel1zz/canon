import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addColumns, CoordDb } from "./db.ts";
import { questions } from "./humans/questions.ts";

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

  test("BR-2131 BR-2078: an old events table gains the worktree column; old events keep an empty one, new ones record the opener's worktree", () => {
    const path = join(mkdtempSync(join(tmpdir(), "canon-old-db-")), "state.db");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, detail TEXT NOT NULL DEFAULT '{}')");
    old.exec("INSERT INTO events(ts, actor, kind) VALUES ('2026-01-01', 'agent:a', 'claim.take')");
    old.close();
    const db = CoordDb.open(path, "/r.worktrees/C-1");
    if (!db.ok) throw new Error(db.error.message);
    db.value.event("agent:a", "claim.renew", "C-1", {});
    expect(db.value.db.query<{ kind: string; worktree: string | null }, []>("SELECT kind, worktree FROM events ORDER BY id").all()).toEqual([
      { kind: "claim.take", worktree: null },
      { kind: "claim.renew", worktree: "/r.worktrees/C-1" },
    ]);
  });
});
