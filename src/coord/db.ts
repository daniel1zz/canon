import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * Coordination state: live, shared by every worktree of one checkout, never committed (design §2).
 * It lives in the git common dir so all linked worktrees see the same file, and every write is
 * immediately visible to every session (P4). Knowledge never goes here; it lives in files.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ids (
  prefix TEXT PRIMARY KEY,
  next   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  subject    TEXT PRIMARY KEY,          -- change id, e.g. C-12
  holder     TEXT NOT NULL,             -- run id
  worktree   TEXT,
  expires_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worktree    TEXT NOT NULL,
  subject     TEXT,                    -- change id when landing a change
  state       TEXT NOT NULL CHECK (state IN ('waiting','landing','landed','failed','abandoned')),
  enqueued_at TEXT NOT NULL,
  heartbeat   TEXT NOT NULL,
  result      TEXT
);
CREATE TABLE IF NOT EXISTS handoffs (
  subject    TEXT PRIMARY KEY,          -- change id
  worktree   TEXT,
  actor      TEXT NOT NULL,
  next       TEXT NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT,
  asked_by    TEXT NOT NULL,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',
  answer      TEXT,
  answered_by TEXT,
  relayed     TEXT,                    -- the human's words when an agent relayed the answer
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  kind    TEXT NOT NULL,               -- e.g. id.allocate, claim.take, check.refuse
  subject TEXT,
  detail  TEXT NOT NULL DEFAULT '{}'   -- JSON; a refusal carries its reason
);
`;

export class CoordDb {
  private constructor(readonly db: Database) {}

  static open(path: string): Result<CoordDb> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path, { create: true, strict: true });
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(SCHEMA);
      // Columns added after the first schema; SQLite has no ADD COLUMN IF NOT EXISTS.
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(questions)").all().map((c) => c.name);
      if (!cols.includes("relayed")) db.exec("ALTER TABLE questions ADD COLUMN relayed TEXT");
      return ok(new CoordDb(db));
    } catch (e) {
      return err("io", `cannot open coordination DB at ${path}: ${(e as Error).message}`);
    }
  }

  /** `<git common dir>/canon/state.db` for the repository containing `cwd`. */
  static pathFor(cwd: string): Result<string> {
    const r = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return err("io", `not inside a git repository: ${r.stderr.toString().trim()}`);
    const common = r.stdout.toString().trim();
    return ok(join(isAbsolute(common) ? common : join(cwd, common), "canon", "state.db"));
  }

  /**
   * Allocates the next id for a prefix. `floor` is the highest number already used in the files,
   * so an id is never reused even when the DB is new or was reset (ids are permanent, P1).
   */
  allocate(prefix: string, floor: number, actor: string): string {
    const tx = this.db.transaction(() => {
      const row = this.db.query<{ next: number }, [string]>("SELECT next FROM ids WHERE prefix = ?").get(prefix);
      const n = Math.max(row?.next ?? 1, floor + 1);
      this.db.query("INSERT INTO ids(prefix, next) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET next = excluded.next").run(prefix, n + 1);
      const id = `${prefix}-${n}`;
      this.event(actor, "id.allocate", id, {});
      return id;
    });
    return tx.immediate();
  }

  event(actor: string, kind: string, subject: string | null, detail: Record<string, unknown>): void {
    this.db
      .query("INSERT INTO events(ts, actor, kind, subject, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, kind, subject, JSON.stringify(detail));
  }

  close(): void {
    this.db.close();
  }
}
