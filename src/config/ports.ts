import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import type { CoordDb } from "../work/db.ts";
import { worktreesDirOf } from "../work/session/config-keys.ts";

/**
 * Per-change ports (C-103, D-41): `ports: <from>-<to>` in canon/config.yaml; each change gets the lowest port of the
 * range that no change whose worktree still exists holds, recorded in the coordination DB so the same change always gets
 * the same value and two changes in progress never share one (BR-2267, BR-2269). It reaches `setup` and every hook as
 * CANON_PORT.
 */
export interface PortRange {
  readonly from: number;
  readonly to: number;
}

const RANGE = /^\s*(\d+)\s*-\s*(\d+)\s*$/;

/** Reads `ports` (BR-2268): null and "" mean unset. */
export function readPorts(v: unknown): Result<PortRange | undefined> {
  if (v === null || v === "") return ok(undefined);
  const bad = err("invalid", "`ports` must be a range of ports written `<from>-<to>`, such as 4100-4199, each between 1 and 65535 and from not above to");
  const m = typeof v === "string" ? RANGE.exec(v) : null;
  if (!m) return bad;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1 || to > 65535 || from > to) return bad;
  return ok({ from, to });
}

/** A change's port, asked only when a command is about to run (hooks with no commands never allocate). */
export type PortLookup = () => Result<number | undefined>;

/** For an event that is about no change, or a run that belongs to none: CANON_PORT is empty (BR-2267). */
export const noPort: PortLookup = () => ok(undefined);

// reason: the table belongs to this module, so it is created where it is used; CREATE ... IF NOT EXISTS is safe to race (BR-2078)
const SCHEMA = `CREATE TABLE IF NOT EXISTS ports (
  port     INTEGER PRIMARY KEY,
  change   TEXT NOT NULL UNIQUE,
  worktree TEXT NOT NULL,          -- the change's worktree; once it is gone the port is free for another change
  at       TEXT NOT NULL
)`;

/**
 * The port of `change` within `range`, allocating one in a write transaction when it has none (D-41): its own record
 * is kept while it is in the range; otherwise records whose worktree no longer exists are dropped and the lowest free
 * port is taken. A conflict error when every port is held by a change whose worktree still exists (BR-2269).
 */
export function portFor(db: CoordDb, actor: string, change: string, range: PortRange, worktree: string): Result<number> {
  db.db.exec(SCHEMA);
  const tx = db.db.transaction((): Result<number> => {
    const own = db.db.query<{ port: number }, [string]>("SELECT port FROM ports WHERE change = ?").get(change);
    if (own && own.port >= range.from && own.port <= range.to) return ok(own.port);
    if (own) db.db.query("DELETE FROM ports WHERE change = ?").run(change);
    const held = db.db.query<{ port: number; change: string; worktree: string }, []>("SELECT port, change, worktree FROM ports ORDER BY port").all();
    const taken = new Set<number>();
    const holders: string[] = [];
    for (const h of held) {
      if (!existsSync(h.worktree)) {
        db.db.query("DELETE FROM ports WHERE port = ?").run(h.port);
        db.event(actor, "port.free", h.change, { port: h.port, worktree: h.worktree });
        continue;
      }
      taken.add(h.port);
      if (h.port >= range.from && h.port <= range.to) holders.push(`${h.change} (${h.port})`);
    }
    for (let port = range.from; port <= range.to; port++) {
      if (taken.has(port)) continue;
      db.db.query("INSERT INTO ports(port, change, worktree, at) VALUES (?, ?, ?, ?)").run(port, change, worktree, new Date().toISOString());
      db.event(actor, "port.allocate", change, { port, worktree });
      return ok(port);
    }
    db.event(actor, "port.refuse", change, { range: `${range.from}-${range.to}` });
    return err(
      "conflict",
      `no free port for ${change} in ports ${range.from}-${range.to}: every one is held by a change whose worktree still exists: ${holders.join(", ")}; clean worktrees no longer in use (canon work clean) or widen \`ports\``,
    );
  });
  return tx.immediate();
}

/**
 * The lookup for a hook of `change` (BR-2267): undefined without `ports` or without a change; a change with no record
 * yet is recorded against its conventional worktree, `<worktrees dir>/<change>` (D-41).
 */
export function changePort(
  ws: { readonly db: CoordDb; readonly actor: string; readonly primary: string; readonly config: { readonly ports: PortRange | undefined; readonly worktrees: string | undefined } },
  change: string | null,
): PortLookup {
  const range = ws.config.ports;
  if (!range || !change) return noPort;
  return () => portFor(ws.db, ws.actor, change, range, join(worktreesDirOf(ws.config, ws.primary), change));
}
