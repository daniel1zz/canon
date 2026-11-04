import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { isGone, processOf, selfProcess, sessionProcess, type Proc } from "./liveness.ts";
import { claims, holdClaim, keepClaim, renewClaim, takeClaim, unholdClaim } from "./claims.ts";
import { enqueue, finishEntry, tryTurn } from "../land/queue.ts";
import { land } from "../land/land.ts";
import { stop } from "../session/session.ts";
import { computeStats } from "../stats/stats.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { writeFileSync } from "node:fs";

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
    const h = holdClaim(d, "C-1", "/wt/C-1", "human:x");
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
    const cleaning = holdClaim(d, "C-1", "/wt/C-1", "human:x");
    if (!cleaning.ok) throw new Error(cleaning.error.message);
    const dropping = holdClaim(d, "C-1", "/wt/C-1", "human:x");
    expect(!dropping.ok && dropping.error.code).toBe("conflict");
    expect(holdClaim(d, "C-1", "/wt/C-1", "human:x").ok).toBe(false);
    unholdClaim(d, { ...cleaning.value, mark: `${cleaning.value.mark}x` }); // some other hold's end
    expect(claims(d).length).toBe(1);
  });

  test("BR-2100: a hold left by a clean or drop that was killed frees as soon as its process is gone", async () => {
    const d = db();
    expect(holdClaim(d, "C-1", "/wt/C-1", "agent:a").ok).toBe(true);
    expect(d.db.query<{ pid: number }, []>("SELECT pid FROM claims").get()?.pid).toBe(process.pid);
    const dead = await deadProcess();
    d.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = 'C-1'").run(dead.pid, dead.start);
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b").ok).toBe(true);
    expect(claims(d).map((c) => c.actor)).toEqual(["agent:b"]);
  });
});

const HOUR = 3600_000;
const expiresOf = (d: CoordDb, subject: string) => d.db.query<{ expires_at: string }, [string]>("SELECT expires_at FROM claims WHERE subject = ?").get(subject)?.expires_at;
/** Moves a claim's lease by `ms`, standing in for time passing since it was taken or renewed. */
const shift = (d: CoordDb, subject: string, ms: number) =>
  d.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(new Date(expiresOf(d, subject)!).getTime() + ms).toISOString(), subject);

describe("the lease", () => {
  test("BR-2011: a refused start does not renew the lease, the holder's own start included", () => {
    const d = db();
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * HOUR).ok).toBe(true);
    shift(d, "C-1", -HOUR);
    const before = expiresOf(d, "C-1");
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * HOUR).ok).toBe(false);
    expect(takeClaim(d, "C-1", "/wt/C-2", "agent:b", 12 * HOUR).ok).toBe(false);
    expect(expiresOf(d, "C-1")).toBe(before);
  });

  test("BR-2011: a lease that expired is taken over; one renewed by a stop 3 hours ago still has 9 hours and refuses", () => {
    const d = db();
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * HOUR);
    shift(d, "C-1", -13 * HOUR); // taken 13 hours ago, never renewed
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b", 12 * HOUR).ok).toBe(true);
    takeClaim(d, "C-2", "/wt/C-2", "agent:a", 12 * HOUR);
    shift(d, "C-2", -10 * HOUR); // taken 13 hours ago ...
    expect(renewClaim(d, "/wt/C-2", "agent:a", 12 * HOUR).ok).toBe(true); // ... and a `canon work stop` renews it from now
    shift(d, "C-2", -3 * HOUR); // that stop was 3 hours ago
    const left = new Date(expiresOf(d, "C-2")!).getTime() - Date.now();
    expect(Math.abs(left - 9 * HOUR)).toBeLessThan(60_000);
    expect(takeClaim(d, "C-2", "/wt/C-2", "agent:b", 12 * HOUR).ok).toBe(false);
  });

  test("BR-2011: with claim_lease_hours: 1 a claim taken two hours ago and not renewed is taken over", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nclaim_lease_hours: 1\n");
    sh(root, "commit", "-qam", "short lease");
    const s = startNew(root, "Short lease");
    const d = ws(root).db;
    expect(Math.abs(new Date(expiresOf(d, s.change)!).getTime() - Date.now() - HOUR)).toBeLessThan(60_000);
    shift(d, s.change, -2 * HOUR);
    const b = ws(root, "agent:b");
    expect(takeClaim(b.db, s.change, s.worktree, "agent:b", b.config.claimLeaseMs).ok).toBe(true);
    expect(claims(d).map((c) => c.actor)).toEqual(["agent:b"]);
  });

  test("BR-2100: the holder renewing outside Claude Code keeps the process the claim names; another actor taking it over records none", () => {
    const d = db();
    const me = selfProcess()!;
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * HOUR, me);
    const pid = () => d.db.query<{ pid: number | null }, []>("SELECT pid FROM claims WHERE subject = 'C-1'").get()?.pid;
    expect(renewClaim(d, "/wt/C-1", "agent:a", 12 * HOUR, undefined).ok).toBe(true);
    expect(pid()).toBe(me.pid);
    shift(d, "C-1", -13 * HOUR);
    expect(renewClaim(d, "/wt/C-1", "agent:b", 12 * HOUR, undefined).ok).toBe(true);
    expect(pid()).toBeNull();
  });
});

describe("only the holder works in its worktree", () => {
  test("BR-2104: another actor's stop and land in the holder's worktree write claim.refuse, counted by canon stats as the claim check, not as a landing refusal", async () => {
    const root = project();
    const s = startNew(root, "Held");
    const b = ws(s.worktree, "agent:b");
    expect(stop(b, "x", undefined, false).ok).toBe(false);
    expect((await land(ws(s.worktree, "agent:b"), FAST, quiet)).kind).toBe("refused");
    const d = ws(root).db;
    const kinds = d.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind IN ('claim.refuse','land.refuse') ORDER BY id").all().map((e) => e.kind);
    expect(kinds).toEqual(["claim.refuse", "claim.refuse"]);
    const claim = computeStats(d, {}, "2026-01-01").find((c) => c.check === "claim");
    expect(claim?.refused).toBe(2);
  });

  test("BR-2108: once agent:b has taken the claim over, the lander's renewal leaves agent:b's claim as it is", () => {
    const d = db();
    takeClaim(d, "C-1", "/wt/C-1", "agent:a", 12 * HOUR);
    shift(d, "C-1", -13 * HOUR);
    expect(takeClaim(d, "C-1", "/wt/C-1", "agent:b", 12 * HOUR).ok).toBe(true);
    const row = () => d.db.query("SELECT holder, worktree, expires_at, pid, pid_start, version FROM claims").all();
    const before = row();
    keepClaim(d, "/wt/C-1", "agent:a", 12 * HOUR);
    expect(row()).toEqual(before);
  });
});

describe("the claim names the session again when a landing ends", () => {
  const pidOf = (root: string, change: string) => ws(root).db.db.query<{ pid: number | null }, [string]>("SELECT pid FROM claims WHERE subject = ?").get(change)?.pid;
  const CLI = join(import.meta.dir, "../../cli/main.ts");

  /** A change whose claim names a live stand-in session process, outside Claude Code (so land keeps that process, BR-2100). */
  async function withSession(body: (root: string, s: { change: string; worktree: string }, session: number) => Promise<void>, config?: string) {
    const saved = process.env["CLAUDECODE"];
    delete process.env["CLAUDECODE"];
    const session = Bun.spawn(["sleep", "60"]);
    try {
      const root = project();
      if (config) {
        writeFileSync(join(root, "canon/config.yaml"), config);
        sh(root, "commit", "-qam", "config");
      }
      const s = startNew(root, "Session");
      const p = processOf(session.pid)!;
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(p.pid, p.start, s.change);
      await body(root, s, session.pid);
    } finally {
      session.kill();
      if (saved === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = saved;
    }
  }

  test("BR-2142: a refused landing names the session process again", async () => {
    await withSession(async (root, s, session) => {
      writeFileSync(join(s.worktree, "FAIL"), "x\n");
      sh(s.worktree, "add", "FAIL");
      sh(s.worktree, "commit", "-qm", "fail the floor");
      expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("refused");
      expect(pidOf(root, s.change)).toBe(session);
    });
  });

  test("BR-2142: a landing that times out in the queue names the session process again", async () => {
    await withSession(async (root, s, session) => {
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b", selfProcess());
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const r = await land(ws(s.worktree), { ...FAST, timeoutMs: 800 }, quiet);
      expect(r.kind).toBe("timeout");
      expect(pidOf(root, s.change)).toBe(session);
      finishEntry(other.db, ahead, "landed", "x");
    });
  });

  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    test(`BR-2142: a landing interrupted by ${signal} names the session process again`, async () => {
      await withSession(
        async (root, s, session) => {
          const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
          delete env["CLAUDECODE"];
          const lander = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "ignore", stderr: "ignore", env });
          for (let i = 0; i < 300 && pidOf(root, s.change) !== lander.pid; i++) await Bun.sleep(50);
          expect(pidOf(root, s.change)).toBe(lander.pid);
          lander.kill(signal);
          expect(await lander.exited).toBe(code);
          expect(pidOf(root, s.change)).toBe(session);
        },
        'floor: "sleep 30"\ntests: []\n',
      );
    }, 30_000);
  }
});

