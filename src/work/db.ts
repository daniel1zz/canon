import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * Coordination state: live, shared by every worktree of one checkout, never committed (design §2).
 * It lives in the git common dir so all linked worktrees see the same file, and every write is
 * immediately visible to every session (P4). Knowledge never goes here; it lives in files.
 */
/** The open review findings table and its index (BR-2434), also used to rebuild an older one (widenFindingsCheck). */
const FINDINGS_TABLE = `CREATE TABLE IF NOT EXISTS review_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  identity     TEXT NOT NULL,           -- criterion, sorted named ids and quote hash (BR-2433)
  criterion    TEXT NOT NULL,
  ids          TEXT NOT NULL,           -- JSON list of the document ids the text names, sorted
  docs         TEXT NOT NULL,           -- JSON list of the documents it is attached to
  text         TEXT NOT NULL,
  change       TEXT,                    -- the change whose review gave it, when there was one
  event        INTEGER NOT NULL,        -- the event that recorded the review it came from
  sha          TEXT,                    -- the commit that review saw
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  closed_how   TEXT CHECK (closed_how IN ('retired', 'spurious', 'fixed', 'no-longer-holds')),
  closed_event INTEGER                  -- the event that closed it: the landing, the verdict, the finding.close or an older re-asking
);
CREATE UNIQUE INDEX IF NOT EXISTS review_findings_open ON review_findings(identity) WHERE closed_at IS NULL;`;

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
-- A claim that failed is recorded once per change, claim version and kind (BR-2360, D-66); also added to old databases by this statement.
CREATE UNIQUE INDEX IF NOT EXISTS events_claim_lapse ON events(subject, kind, json_extract(detail, '$.version')) WHERE kind IN ('claim.expired', 'claim.holder-gone');
-- A passed rule review is found by the hash of its prompts, to be reused (BR-2361, D-70).
-- (the index of an earlier version covered only review.ok; the newest verdict of a hash must see blocks too)
DROP INDEX IF EXISTS events_review_hash;
CREATE INDEX IF NOT EXISTS events_review_verdict_hash ON events(json_extract(detail, '$.hash')) WHERE kind IN ('review.ok', 'review.block');
CREATE INDEX IF NOT EXISTS events_preview_hash ON events(json_extract(detail, '$.hash')) WHERE kind = 'review.preview';
-- The one \`canon floor watch\` running for this repository, by pid and process start (BR-2219, D-11).
CREATE TABLE IF NOT EXISTS watcher (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  pid_start  TEXT NOT NULL,
  sha        TEXT,                     -- the commit it is testing
  started_at TEXT NOT NULL
);
-- The one post-land code review running for this repository, by pid and process start (BR-2314, D-11).
CREATE TABLE IF NOT EXISTS code_reviewer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  pid_start  TEXT NOT NULL,
  started_at TEXT NOT NULL
);
-- The one process waiting for the due post-land code review, by pid and process start (BR-2314, D-68).
CREATE TABLE IF NOT EXISTS code_review_waiter (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  pid_start  TEXT NOT NULL,
  started_at TEXT NOT NULL
);
-- "main is failing": at most one row, from the background floor's last failure until it passes (BR-2220, BR-2221).
CREATE TABLE IF NOT EXISTS red_main (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  sha        TEXT NOT NULL,            -- the latest failing commit
  first_sha  TEXT NOT NULL,            -- the commit main first failed on
  log        TEXT NOT NULL,
  tail       TEXT NOT NULL,            -- the last 40 lines of the floor's output
  since      TEXT NOT NULL,            -- when it first failed
  green      TEXT,                     -- refs/canon/green at the first failure
  change     TEXT,                     -- the fix change (canon work start --fix-main)
  fix_pid    INTEGER,                  -- the process opening the fix change, while it does
  fix_start  TEXT,
  updated_at TEXT NOT NULL
);
-- The owner's priority for a change, set with canon backlog urgent and gone when the change lands or it is cleared (BR-2363, D-73).
CREATE TABLE IF NOT EXISTS urgent (
  change TEXT PRIMARY KEY,
  words  TEXT NOT NULL,                -- the owner's own words the relaying actor passed on, for the record only
  actor  TEXT NOT NULL,                -- who relayed them
  at     TEXT NOT NULL
);
-- What each test file held when a report was read: one row per path and git blob hash, the last few per path kept (BR-2337, D-64).
CREATE TABLE IF NOT EXISTS test_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL,
  blob        TEXT NOT NULL,           -- git blob hash of the file's content
  cases       TEXT NOT NULL,           -- JSON list of testcases: suites, classname, name, runs, line
  source      TEXT NOT NULL CHECK (source IN ('test_command','floor')),
  recorded_at TEXT NOT NULL,
  UNIQUE (path, blob)
);
-- Open review findings (BR-2434, D-97): one row per finding identity while it is open, attached to every document it names;
-- closed only explicitly (BR-2435, BR-2438, BR-2453; older rows by re-asking). A closed row stays as the record of how and by which event it closed.
${FINDINGS_TABLE}
-- The rule and duplicate reviews of landed commits, queued by the landing and run one at a time after it (BR-2441, D-89).
CREATE TABLE IF NOT EXISTS landed_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- queue order
  entry       INTEGER NOT NULL,         -- the landing's queue entry, as after_land batches are found by (BR-2166)
  change      TEXT,
  base        TEXT NOT NULL,            -- main before the landing: its config decides how the review runs (BR-2074)
  head        TEXT NOT NULL,            -- the landed commit the review reads
  landed      INTEGER NOT NULL,         -- the land.ok event
  log         TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  queued_at   TEXT NOT NULL,
  finished_at TEXT
);
-- The one process running the queued landed reviews, by pid and process start (BR-2441, D-11, D-83).
CREATE TABLE IF NOT EXISTS landed_reviewer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  pid_start  TEXT NOT NULL,
  started_at TEXT NOT NULL
);
`;

/** Columns added after the first schema, as `table`, `column definition`. */
const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
  ["questions", "relayed TEXT"],
  // The process behind a claim (its Claude Code session) and behind a queue entry (the lander), by pid and start time (D-11).
  ["claims", "pid INTEGER"],
  ["claims", "pid_start TEXT"],
  ["queue", "pid INTEGER"],
  ["queue", "pid_start TEXT"],
  // The worktree each event was run from: with session-level actors, it is what tells a session's agents apart (BR-2131, D-18).
  ["events", "worktree TEXT"],
  // Batched landings (D-26): the leader entry testing this one, the HEAD this entry had when it joined, and
  // whether it must land on its own after a failed batch (BR-2172, BR-2173).
  ["queue", "batch INTEGER"],
  ["queue", "head TEXT"],
  ["queue", "solo INTEGER"],
  // Until when an entry refused for a conflict keeps its place for its own next landing (BR-2177, D-29).
  ["queue", "keep_until TEXT"],
  // Whether a relayed answer matched the session's latest record from Claude Code's question tool (BR-2276, D-45).
  ["questions", "witness TEXT"],
  // Whether the question was asked as multi-select, so a relayed answer may name several of its options (BR-2021, issue #130).
  ["questions", "multi INTEGER NOT NULL DEFAULT 0"],
  // Whether the entry runs a floor scope's command instead of the floor, so it goes ahead of full-floor landings (BR-2399, D-82).
  ["queue", "scoped INTEGER"],
];

/**
 * Brings an older DB up to the current schema (BR-2078). SQLite has no ADD COLUMN IF NOT EXISTS, and checking
 * first races with another session opening the same DB, so every ALTER is attempted and "duplicate column"
 * (someone else added it first) is the expected answer, not an error.
 */
export function addColumns(db: Database): void {
  for (const [table, column] of ADDED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e;
    }
  }
}

/**
 * Lets `review_findings.closed_how` hold `fixed` (BR-2453, D-99) in a DB created before it could. SQLite cannot change a
 * CHECK in place, so the table is rebuilt once, in one immediate transaction that looks again inside it: two sessions
 * opening the same old DB rebuild it once. Older canon builds keep working on the rebuilt table: it only accepts more.
 */
export function widenFindingsCheck(db: Database): void {
  const old = (): boolean => {
    const row = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_findings'").get();
    return row !== null && !row.sql.includes("'fixed'");
  };
  if (!old()) return;
  db.transaction(() => {
    if (!old()) return;
    db.exec(`ALTER TABLE review_findings RENAME TO review_findings_old;
DROP INDEX IF EXISTS review_findings_open;
${FINDINGS_TABLE}
INSERT INTO review_findings SELECT id, identity, criterion, ids, docs, text, change, event, sha, opened_at, closed_at, closed_how, closed_event FROM review_findings_old;
DROP TABLE review_findings_old;`);
  }).immediate();
}

/**
 * Switches the DB to WAL. SQLite answers "database is locked" at once, without calling the busy handler, when
 * another connection is switching the same fresh file at the same moment, so the switch is retried until the
 * busy timeout is spent; any other error, or a lock that outlasts it, still fails the open.
 */
// reason: BR-2132 — concurrent first `canon work start`s failed to open the DB on this switch (2 of 10 runs of 8).
function enableWal(db: Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (e) {
      if (!/database is locked/i.test((e as Error).message) || Date.now() > deadline) throw e;
      Bun.sleepSync(5 + Math.random() * 20);
    }
  }
}

export class CoordDb {
  /** `worktree`: the toplevel of the worktree the command runs in, recorded on every event (BR-2131). */
  private constructor(
    readonly db: Database,
    private readonly worktree: string | null,
  ) {}

  static open(path: string, worktree?: string): Result<CoordDb> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      enableWal(db);
      db.exec(SCHEMA);
      addColumns(db);
      widenFindingsCheck(db);
      return ok(new CoordDb(db, worktree ?? null));
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

  /** Writes one event; returns its id. */
  event(actor: string, kind: string, subject: string | null, detail: Record<string, unknown>): number {
    return Number(
      this.db
        .query("INSERT INTO events(ts, actor, kind, subject, detail, worktree) VALUES (?, ?, ?, ?, ?, ?)")
        .run(new Date().toISOString(), actor, kind, subject, JSON.stringify(detail), this.worktree).lastInsertRowid,
    );
  }

  /** Writes the event unless an identical one is already recorded under a unique index on events; true when it wrote (BR-2360). */
  eventOnce(actor: string, kind: string, subject: string | null, detail: Record<string, unknown>): boolean {
    // reason: a read first, so a lapse already recorded takes no write lock each time a command judges it again (BR-2360).
    const seen = this.db
      .query("SELECT 1 FROM events WHERE subject IS ? AND kind = ? AND json_extract(detail, '$.version') IS ? AND kind IN ('claim.expired', 'claim.holder-gone') LIMIT 1")
      .get(subject, kind, (detail["version"] as number | undefined) ?? null);
    if (seen) return false;
    return (
      this.db
        .query("INSERT OR IGNORE INTO events(ts, actor, kind, subject, detail, worktree) VALUES (?, ?, ?, ?, ?, ?)")
        .run(new Date().toISOString(), actor, kind, subject, JSON.stringify(detail), this.worktree).changes > 0
    );
  }

  close(): void {
    this.db.close();
  }
}
