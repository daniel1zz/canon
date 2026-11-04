import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renewClaim, takeClaim } from "../../claims/claims.ts";
import { enqueue, finishEntry, heartbeat, tryTurn } from "./queue.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { land } from "../land.ts";
import { waitPollMs } from "./wait.ts";
import { processOf, selfProcess, type Proc } from "../../claims/liveness.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;

describe("the claim names the lander while it lands", () => {
  async function deadProcess(): Promise<Proc> {
    const p = Bun.spawn(["sleep", "30"]);
    const proc = processOf(p.pid);
    if (!proc) throw new Error("no start time for a live child");
    p.kill("SIGKILL");
    await p.exited;
    return proc;
  }
  const pidOf = (root: string, change: string) => ws(root).db.db.query<{ pid: number | null }, [string]>("SELECT pid FROM claims WHERE subject = ?").get(change)?.pid;
  // reason: outside Claude Code, land keeps the session process the claim already names (BR-2100), so a test can set it.
  async function landingAsSession(session: Proc | null, body: (root: string, s: { change: string; worktree: string }, landing: Promise<unknown>) => Promise<void>) {
    const saved = process.env["CLAUDECODE"];
    delete process.env["CLAUDECODE"];
    try {
      const root = project();
      const s = startNew(root, "Session exits");
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(session?.pid ?? null, session?.start ?? null, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const landing = land(ws(s.worktree), FAST, quiet);
      await Bun.sleep(300);
      await body(root, s, (async () => { finishEntry(other.db, ahead, "landed", "x"); return landing; })());
    } finally {
      if (saved === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = saved;
    }
  }

  test("BR-2142: a session that exits while its landing waits does not free the claim until the landing ends", async () => {
    await landingAsSession(await deadProcess(), async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBe(process.pid); // the lander, which is this test process
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(true); // the session is gone
    });
  });

  test("BR-2142: a work command of the session while its landing waits leaves the claim naming the lander", async () => {
    const session = Bun.spawn(["sleep", "30"]);
    const p = processOf(session.pid)!;
    await landingAsSession(p, async (root, s, landing) => {
      expect(renewClaim(ws(root).db, s.worktree, "agent:a", 12 * 3600_000, p).ok).toBe(true); // e.g. `canon work stop` from the session
      expect(pidOf(root, s.change)).toBe(process.pid);
      session.kill();
      await session.exited;
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(true);
    });
  });

  test("BR-2142: a session still running names the claim again after the landing, so it still binds", async () => {
    const session = Bun.spawn(["sleep", "30"]);
    try {
      await landingAsSession(processOf(session.pid)!, async (root, s, landing) => {
        expect(((await landing) as { kind: string }).kind).toBe("landed");
        expect(pidOf(root, s.change)).toBe(session.pid);
        expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      });
    } finally {
      session.kill();
    }
  });

  test("BR-2142: a lander killed with SIGKILL leaves the claim naming a gone process, so it can be taken at once", async () => {
    const root = project();
    const s = startNew(root, "Lander killed");
    const session = Bun.spawn(["sleep", "30"]);
    try {
      const p0 = processOf(session.pid)!;
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(p0.pid, p0.start, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
      delete env["CLAUDECODE"];
      const lander = Bun.spawn(["bun", join(import.meta.dir, "../../../cli/main.ts"), "work", "land"], { cwd: s.worktree, stdout: "ignore", stderr: "ignore", env });
      for (let i = 0; i < 200 && pidOf(root, s.change) !== lander.pid; i++) await Bun.sleep(50);
      expect(pidOf(root, s.change)).toBe(lander.pid);
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(false);
      lander.kill("SIGKILL");
      await lander.exited;
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(true);
    } finally {
      session.kill();
    }
  }, TIMED);

  test("BR-2142: after a lander is killed with SIGKILL, a work command of the live session names the session again", async () => {
    const root = project();
    const s = startNew(root, "Lander killed, session lives");
    const session = Bun.spawn(["sleep", "30"]);
    try {
      const p0 = processOf(session.pid)!;
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(p0.pid, p0.start, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
      delete env["CLAUDECODE"];
      const lander = Bun.spawn(["bun", join(import.meta.dir, "../../../cli/main.ts"), "work", "land"], { cwd: s.worktree, stdout: "ignore", stderr: "ignore", env });
      for (let i = 0; i < 200 && pidOf(root, s.change) !== lander.pid; i++) await Bun.sleep(50);
      expect(pidOf(root, s.change)).toBe(lander.pid);
      lander.kill("SIGKILL");
      await lander.exited; // its queue row is still active
      expect(renewClaim(ws(root).db, s.worktree, "agent:a", 12 * 3600_000, p0).ok).toBe(true); // e.g. `canon work stop`
      expect(pidOf(root, s.change)).toBe(session.pid);
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(false);
    } finally {
      session.kill();
    }
  }, TIMED);

  test("BR-2142: a lease-only claim names no process during or after the landing", async () => {
    await landingAsSession(null, async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBeNull();
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(pidOf(root, s.change)).toBeNull();
    });
  });
});

describe("a lander killed by a signal", () => {
  const CLI = join(import.meta.dir, "../../../cli/main.ts");
  const entryOf = (root: string) => ws(root).db.db.query<{ id: number; state: string; result: string | null }, []>("SELECT id, state, result FROM queue ORDER BY id DESC LIMIT 1").get();
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(50);
    expect(what()).toBe(true);
  };

  test("BR-2099: SIGTERM while the floor runs fails the entry as killed, records it, exits 143, and the next lander goes at once", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"sleep 30\"\ntests: []\n");
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed");
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const logs = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs");
    await until(() => entryOf(root)?.state === "landing" && existsSync(join(logs, `land-${entryOf(root)!.id}.log`))); // the floor runs
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
    const kinds = ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'land.%' AND kind != 'land.turn'").all().map((e) => e.kind);
    expect(kinds).toEqual(["land.killed"]); // an interruption, not a check's refusal (BR-2067)
    const other = ws(root, "agent:b");
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b).mine).toBe(true);
  }, TIMED);

  test("BR-2018: a --finish lander killed by SIGTERM takes its close commit back", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"sleep 30\"\ntests: []\n");
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed finish");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const logs = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs");
    await until(() => entryOf(root)?.state === "landing" && existsSync(join(logs, `land-${entryOf(root)!.id}.log`)));
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
  });

  test("BR-2018 BR-2099: a SIGTERM while --finish makes its close commit, before the landing queues, still takes the close commit back", async () => {
    const root = project();
    const s = startNew(root, "Killed while closing");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, "..", `${root.split("/").pop()}-closing`);
    writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\ntouch ${marker}\nsleep 2\n`, { mode: 0o755 });
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await until(() => existsSync(marker)); // the close commit is being made
    p.kill("SIGTERM"); // canon only: git finishes the commit
    expect(await p.exited).toBe(143);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
  }, TIMED);

  test("BR-2099: a process group killed in the middle of the rebase leaves the worktree on its own commits, not mid-rebase", async () => {
    const root = project();
    const s = startNew(root, "Killed mid-rebase");
    writeFileSync(join(s.worktree, "mine.txt"), "mine\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const before = sh(s.worktree, "rev-parse", "HEAD");
    writeFileSync(join(root, "theirs.txt"), "theirs\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "main moved"); // so the rebase has work to do
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, "..", `${root.split("/").pop()}-in-rebase`);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${marker}\nsleep 30\n`, { mode: 0o755 });
    // reason: a new process group, so the signal reaches git and the hook too, as a tool timeout's would.
    const p = Bun.spawn(["perl", "-e", "setpgrp(0,0); exec @ARGV", "bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await until(() => existsSync(marker));
    process.kill(-p.pid, "SIGTERM");
    expect(await p.exited).toBe(143);
    expect(existsSync(join(sh(s.worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge")))).toBe(false);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(before);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
  }, TIMED);
});

describe("a waiting lander's heartbeat", () => {
  test("BR-2044: with a stale time under the 2 s poll, a waiting lander keeps beating and is not skipped by the one behind it", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nlander_stale_minutes: 0.01\n"); // 0.6 s
    sh(root, "commit", "-qam", "short stale time");
    const s = startNew(root, "Waits");
    const staleMs = 600;
    const other = ws(root, "agent:b");
    const me = selfProcess();
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b", me);
    expect(tryTurn(other.db, ahead, staleMs).mine).toBe(true);
    const beat = setInterval(() => heartbeat(other.db, ahead), 100);
    try {
      const landing = land(ws(s.worktree), FAST, quiet);
      await Bun.sleep(300);
      const behind = enqueue(other.db, "/elsewhere-too", "C-98", "agent:c", me);
      // reason: the entry behind tries for its turn often, so a waiting lander silent for more than 0.6 s would be marked abandoned
      for (let i = 0; i < 30; i++) {
        tryTurn(other.db, behind, staleMs);
        await Bun.sleep(100);
      }
      const state = () => other.db.db.query<{ state: string }, [string]>("SELECT state FROM queue WHERE subject = ? ORDER BY id DESC LIMIT 1").get(s.change)?.state;
      expect(state()).toBe("waiting");
      finishEntry(other.db, behind, "failed", "test");
      clearInterval(beat);
      finishEntry(other.db, ahead, "landed", "x");
      expect((await landing).kind).toBe("landed");
      // the other side: at the default 10 minutes the wait poll stays at 2 s
      expect([waitPollMs(staleMs), waitPollMs(10 * 60_000)]).toEqual([200, 2000]);
    } finally {
      clearInterval(beat);
    }
  }, TIMED);
});
