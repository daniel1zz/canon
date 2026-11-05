import { err, ok, type Result } from "../../kernel/result.ts";
import { existsSync } from "node:fs";
import type { CoordDb } from "../db.ts";

/**
 * Per-change ports (C-103, D-41, D-48): `ports: <from>-<to>` in canon/config.yaml; each change gets a port of the range
 * that no change whose worktree still exists holds and that binds, recorded in the coordination DB so the same change
 * always gets the same value and two changes in progress never share one (BR-2267, BR-2269, BR-2288). It reaches
 * `setup` and every hook as CANON_PORT.
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

/**
 * A change's port, asked only when a command is about to run. ok(undefined): no port is configured for this run;
 * an error: ports are configured but this change has none, and the message says why (BR-2287).
 */
export type PortLookup = () => Result<number | undefined>;

/** For an event that is about no change, or a run that belongs to none: CANON_PORT is empty (BR-2267). */
export const noPort: PortLookup = () => ok(undefined);

// reason: the tables belong to this module, so they are created where they are used; CREATE ... IF NOT EXISTS is safe to race (BR-2078)
const SCHEMA = `CREATE TABLE IF NOT EXISTS ports (
  port     INTEGER PRIMARY KEY,
  change   TEXT NOT NULL UNIQUE,
  worktree TEXT NOT NULL,          -- the change's worktree; once it is gone the port is free for another change
  at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ports_used (
  port INTEGER PRIMARY KEY,
  seq  INTEGER NOT NULL            -- when canon last handed this port to a change, as an order: higher is more recent (BR-2288)
)`;

/** Marks `port` as handed to a change just now, after every other port (BR-2288). */
function used(db: CoordDb, port: number): void {
  db.db
    .query("INSERT INTO ports_used(port, seq) VALUES (?1, (SELECT coalesce(max(seq), 0) + 1 FROM ports_used)) ON CONFLICT(port) DO UPDATE SET seq = (SELECT coalesce(max(seq), 0) + 1 FROM ports_used)")
    .run(port);
}

// reason: on macOS a listener on 0.0.0.0 leaves 127.0.0.1 bindable and one on ::1 leaves 0.0.0.0 bindable, so one address cannot tell (D-48)
const PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

/** Whether `port` can be listened on at every local address the machine has; an address it lacks is skipped (BR-2288). */
export function bindable(port: number): boolean {
  for (const hostname of PROBE_HOSTS) {
    try {
      Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") continue;
      return false;
    }
  }
  return true;
}

/**
 * The port of `change` within `range`, allocating one in a write transaction when it has none (D-41, D-48):
 * its own record is kept while its port is in the range, and points at `worktree` from then on, which must be the
 * change's worktree as it exists now. Otherwise records whose worktree no longer exists are dropped, and the first
 * port that binds is taken: never-used ports from the lowest, then freed ones the least recently used first
 * (BR-2288). A conflict error when no port is left (BR-2269).
 */
export function portFor(db: CoordDb, actor: string, change: string, range: PortRange, worktree: string): Result<number> {
  db.db.exec(SCHEMA);
  const tx = db.db.transaction((): Result<number> => {
    const now = new Date().toISOString();
    const own = db.db.query<{ port: number }, [string]>("SELECT port FROM ports WHERE change = ?").get(change);
    if (own && own.port >= range.from && own.port <= range.to) {
      db.db.query("UPDATE ports SET worktree = ?, at = ? WHERE change = ?").run(worktree, now, change);
      used(db, own.port);
      return ok(own.port);
    }
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
    const last = new Map(db.db.query<{ port: number; seq: number }, []>("SELECT port, seq FROM ports_used").all().map((r) => [r.port, r.seq]));
    const free: number[] = [];
    for (let port = range.from; port <= range.to; port++) if (!taken.has(port)) free.push(port);
    // reason: a freed port may still be held by a server its gone worktree left running; the one used longest ago is the least likely to be (D-48)
    free.sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0) || a - b);
    const busy: number[] = [];
    for (const port of free) {
      if (!bindable(port)) {
        busy.push(port);
        continue;
      }
      db.db.query("INSERT INTO ports(port, change, worktree, at) VALUES (?, ?, ?, ?)").run(port, change, worktree, now);
      used(db, port);
      db.event(actor, "port.allocate", change, { port, worktree, ...(busy.length > 0 ? { busy } : {}) });
      return ok(port);
    }
    db.event(actor, "port.refuse", change, { range: `${range.from}-${range.to}`, busy });
    const parts = [
      ...(holders.length > 0 ? [`held by a change whose worktree still exists: ${holders.join(", ")}`] : []),
      ...(busy.length > 0 ? [`in use by a process outside canon: ${busy.sort((a, b) => a - b).join(", ")}`] : []),
    ];
    return err(
      "conflict",
      `no free port for ${change} in ports ${range.from}-${range.to}: ${parts.join("; ")}; clean worktrees no longer in use (canon work clean), stop what holds the port, or widen \`ports\``,
    );
  });
  return tx.immediate();
}

/**
 * The lookup for `before_land` and `after_land` (BR-2267, D-48): they run in a batch worktree or the primary checkout,
 * not necessarily in the change's worktree, so they only read the change's record and never make one. Undefined
 * without `ports` or without a change; an error, which leaves CANON_PORT empty (BR-2287), when the change has no
 * port in the range.
 */
export function changePort(ws: { readonly db: CoordDb; readonly config: { readonly ports: PortRange | undefined } }, change: string | null): PortLookup {
  const range = ws.config.ports;
  if (!range || !change) return noPort;
  return () => {
    ws.db.db.exec(SCHEMA);
    const tx = ws.db.db.transaction((): Result<number> => {
      const own = ws.db.db.query<{ port: number }, [string]>("SELECT port FROM ports WHERE change = ?").get(change);
      if (!own) return err("not_found", `${change} has no port recorded; it gets one when \`canon work start ${change}\` or \`canon work stop\` runs for it`);
      if (own.port < range.from || own.port > range.to) return err("not_found", `${change}'s recorded port ${own.port} is outside ports ${range.from}-${range.to}; it gets a new one when \`canon work start ${change}\` or \`canon work stop\` runs for it`);
      used(ws.db, own.port);
      return ok(own.port);
    });
    return tx.immediate();
  };
}
