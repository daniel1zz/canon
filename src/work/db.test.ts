import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addColumns, CoordDb } from "./db.ts";
import { questions } from "./humans/questions.ts";
import { project, startNew, ws } from "./testkit.ts";

const MAIN = join(import.meta.dir, "..", "invocation", "main.ts");

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

  test("BR-2078 BR-2453: an old review_findings table is rebuilt once to accept fixed, keeping its rows, the open index and older closes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "canon-old-db-")), "state.db");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE review_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, criterion TEXT NOT NULL, ids TEXT NOT NULL, docs TEXT NOT NULL, text TEXT NOT NULL, change TEXT, event INTEGER NOT NULL, sha TEXT, opened_at TEXT NOT NULL, closed_at TEXT, closed_how TEXT CHECK (closed_how IN ('retired', 'spurious', 'no-longer-holds')), closed_event INTEGER);
CREATE UNIQUE INDEX review_findings_open ON review_findings(identity) WHERE closed_at IS NULL;
INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at) VALUES ('a', 'contradiction', '[]', '["x"]', 'open one', 1, 'x');
INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at, closed_at, closed_how) VALUES ('b', 'untestable', '[]', '["x"]', 'old close', 1, 'x', 'y', 'no-longer-holds');`);
    old.close();
    const a = CoordDb.open(path);
    const b = CoordDb.open(path);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const db = a.value.db;
    expect(db.query<{ text: string; closed_how: string | null }, []>("SELECT text, closed_how FROM review_findings ORDER BY id").all()).toEqual([
      { text: "open one", closed_how: null },
      { text: "old close", closed_how: "no-longer-holds" },
    ]);
    db.exec("UPDATE review_findings SET closed_at = 'z', closed_how = 'fixed' WHERE id = 1");
    expect(db.query<{ closed_how: string }, []>("SELECT closed_how FROM review_findings WHERE id = 1").get()!.closed_how).toBe("fixed");
    expect(() => db.exec("INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at, closed_how) VALUES ('c', 'x', '[]', '[]', 't', 1, 'x', 'bogus')")).toThrow();
    db.exec("INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at) VALUES ('d', 'x', '[]', '[]', 't', 1, 'x')");
    expect(() => db.exec("INSERT INTO review_findings(identity, criterion, ids, docs, text, event, opened_at) VALUES ('d', 'x', '[]', '[]', 't', 1, 'x')")).toThrow();
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'review_findings_old'").get()!.n).toBe(0);
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
