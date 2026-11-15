import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";

test("BR-2078: opening an older coordination database adds delegation state without losing claims", () => {
  const root = mkdtempSync(join(tmpdir(), "canon-delegation-migration-"));
  try {
    const path = join(root, "state.db");
    const old = new Database(path);
    old.exec("CREATE TABLE claims(subject TEXT PRIMARY KEY,holder TEXT NOT NULL,worktree TEXT,expires_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1)");
    old.query("INSERT INTO claims(subject,holder,worktree,expires_at) VALUES (?,?,?,?)").run("C-9", "agent:s1", "/work/C-9", "2099-01-01"); old.close();
    const opened = CoordDb.open(path); expect(opened.ok).toBe(true); if (!opened.ok) return;
    expect(opened.value.db.query("SELECT holder,delegation_epoch FROM claims WHERE subject='C-9'").get()).toEqual({ holder: "agent:s1", delegation_epoch: null });
    expect(opened.value.db.query("SELECT * FROM delegations").all()).toEqual([]); opened.value.close();
    const reopened = CoordDb.open(path); expect(reopened.ok).toBe(true); if (reopened.ok) reopened.value.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
