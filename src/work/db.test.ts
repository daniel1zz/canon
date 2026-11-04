import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addColumns, CoordDb } from "./db.ts";
import { questions } from "./humans/questions.ts";
import { project, startNew, ws } from "./testkit.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

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

describe("where the coordination database lives", () => {
  test("BR-2208: the primary checkout and its worktrees open one file under the git common dir; another repository has its own", () => {
    const root = project();
    const s = startNew(root, "Shared");
    const main = ws(root).root;
    const fromMain = CoordDb.pathFor(root);
    const fromWorktree = CoordDb.pathFor(s.worktree);
    expect(fromMain.ok && fromWorktree.ok).toBe(true);
    if (!fromMain.ok || !fromWorktree.ok) return;
    expect(realpathSync(fromWorktree.value)).toBe(realpathSync(fromMain.value));
    expect(realpathSync(fromMain.value)).toBe(realpathSync(join(main, ".git", "canon", "state.db")));
    ws(s.worktree).db.event("agent:a", "probe.write", s.change, {});
    expect(canon(root, "events", "--kind", "probe.write").out).toContain(` probe.write ${s.change} `);
    expect(canon(project(), "events", "--kind", "probe.write").out.trim()).toBe("(no events)");
  });

  test("BR-2209: a coordination database that cannot be opened exits 4 and names its path; a missing directory is created", () => {
    const root = project();
    writeFileSync(join(root, ".git/canon"), "not a directory\n");
    const r = canon(root, "events");
    expect(r.code).toBe(4);
    expect(r.err).toContain("cannot open coordination DB at");
    expect(r.err).toContain(join(".git", "canon", "state.db"));
    expect(r.out).toBe("");
    expect(canon(project(), "events").code).toBe(0);
  });
});
