import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims } from "../work/claims/claims.ts";
import { start, stop } from "../work/session/session.ts";
import { land } from "../work/land/land.ts";
import { readConfig } from "./config.ts";
import { logFile, runHooksInBackground, waitBackgroundHooks } from "./hooks.ts";
import { changePort } from "./ports.ts";
import { err } from "../kernel/result.ts";
import { enqueue, finishEntry } from "../work/land/queue/queue.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../work/testkit.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

/**
 * A base port with `n` free ports after it, picked at random away from the 4100s of the rules' examples.
 * reason: other worktrees may run this file at the same time, and a test that holds a port would shift their ports (BR-2288).
 */
function base(n = 10): number {
  for (;;) {
    const b = 20_000 + Math.floor(Math.random() * 3_000) * 10;
    const held: { stop(close?: boolean): void }[] = [];
    try {
      for (let p = b; p < b + n; p++) held.push(Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }));
      return b;
    } catch {
      // reason: some port of this block is in use; try another block.
    } finally {
      for (const l of held) l.stop(true);
    }
  }
}

/** Listens on `port` at 127.0.0.1 until stopped, like a dev server left running. */
const hold = (port: number) => Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e): Record<string, unknown> => ({ subject: e.subject, ...(JSON.parse(e.detail) as Record<string, unknown>) }));

function configured(yaml: string) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\n${yaml}`);
  sh(root, "commit", "-qam", "config");
  return root;
}

const portFile = (wt: string, name = "port.txt") => readFileSync(join(wt, name), "utf8").trim();

/** A change file on main, so `canon work start C-n` has something to start. */
function planned(root: string, id: string) {
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, `canon/changes/${id}.md`), `---\nid: ${id}\ntitle: Planned ${id}\nstatus: open\n---\n## 为什么\n\nPlanned.\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", `plan ${id}`);
}

describe("CANON_PORT", () => {
  test("BR-2267: setup sees the change's port; each new change gets the lowest free one", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(portFile(a.value.worktree)).toBe(String(p));
    expect(portFile(b.value.worktree)).toBe(String(p + 1));
  });

  test("BR-2267: the same change keeps its port across start, stop and starting again, in every hook", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\nhooks:\n  after_start: 'echo "$CANON_PORT" >> "$CANON_WORKTREE/../ports.txt"'\n  after_stop: 'echo "$CANON_PORT" >> "$CANON_WORKTREE/../ports.txt"'\n`);
    planned(root, "C-1");
    start(ws(root, "agent:other"), { title: "Takes the first port" }, quiet);
    const s = start(ws(root), { change: "C-1" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    expect(stop(ws(s.value.worktree), "later", undefined, true).ok).toBe(true);
    expect(start(ws(root), { change: "C-1" }, quiet).ok).toBe(true);
    const lines = readFileSync(join(s.value.worktree, "..", "ports.txt"), "utf8").trim().split("\n");
    expect(lines).toEqual([p, p + 1, p + 1, p + 1].map(String));
  });

  test("BR-2267: 8 concurrent CLI starts get 8 different ports, all within the range", async () => {
    const p = base(100);
    const root = configured(`ports: ${p}-${p + 99}\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", MAIN, "work", "start", "--title", `Parallel ${i}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: `agent:p${i}` } }),
    );
    const codes = await Promise.all(procs.map((x) => x.exited));
    expect(codes).toEqual(Array(8).fill(0));
    const ports = claims(ws(root).db).map((c) => Number(portFile(c.holder)));
    expect(new Set(ports).size).toBe(8);
    expect(ports.every((x) => x >= p && x <= p + 99)).toBe(true);
  }, 60_000);

  test("BR-2267: a port whose change's worktree is gone goes to the next change", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 1}\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    sh(root, "worktree", "remove", "--force", a.value.worktree);
    const c = start(ws(root), { title: "C" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    expect(portFile(c.value.worktree)).toBe(String(p));
  });

  test("BR-2267: without ports, CANON_PORT is empty and an inherited CANON_PORT is not passed on", () => {
    const root = configured(`setup: 'echo "[$CANON_PORT]" > port.txt'\nhooks:\n  after_start: 'echo "[$CANON_PORT]" > hook.txt'\n`);
    // reason: Bun.spawn passes the environment the process started with, so only a canon started with CANON_PORT set can show it is not passed on
    const cli = Bun.spawnSync(["bun", MAIN, "work", "start", "--title", "No ports"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_PORT: "9999" } });
    expect(cli.exitCode).toBe(0);
    const wt = claims(ws(root).db)[0]!.holder;
    expect(portFile(wt)).toBe("[]");
    expect(portFile(wt, "hook.txt")).toBe("[]");
  });

  test("BR-2267: after the range changes, the change's next after_stop gets a port in the new range", () => {
    const p = base();
    const q = base();
    const root = configured(`ports: ${p}-${p + 9}\nhooks:\n  after_stop: 'echo "$CANON_PORT" > "$CANON_WORKTREE/../stop.txt"'\n`);
    const s = start(ws(root), { title: "Moves" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    writeFileSync(join(s.value.worktree, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nports: ${q}-${q + 9}\nhooks:\n  after_stop: 'echo "$CANON_PORT" > "$CANON_WORKTREE/../stop.txt"'\n`);
    expect(stop(ws(s.value.worktree), "later", undefined, false).ok).toBe(true);
    expect(readFileSync(join(s.value.worktree, "..", "stop.txt"), "utf8").trim()).toBe(String(q));
  });

  test("BR-2267: after_land of a change with no port record leaves CANON_PORT empty and records no port", async () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\n`);
    const w = ws(root);
    const log = runHooksInBackground({ db: w.db, actor: "agent:a", event: "after_land", change: "C-1", cwd: root, env: {}, port: changePort(w, "C-1") }, ['echo "[$CANON_PORT]"'], logFile(w.db, "after-land-1.log"), 1);
    const batch = await waitBackgroundHooks(w.db, "agent:a", "C-1", 10_000, 50);
    expect(batch?.commands.map((c) => c.exit)).toEqual([0]);
    expect(readFileSync(log, "utf8")).toContain("[]");
    const rows = w.db.db.query<{ change: string }, []>("SELECT change FROM ports").all();
    expect(rows).toEqual([]);
    expect(events(root, "port.allocate")).toEqual([]);
  });

  test("BR-2267: before_land and after_land read the port the change got at start", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\n`);
    const s = start(ws(root), { title: "Has a port" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    const got = changePort(ws(root), s.value.change)();
    expect(got.ok && got.value).toBe(p);
  });

  test("BR-2267: a batch's own setup gets an empty CANON_PORT, not the one canon was run with", async () => {
    const p = base();
    const root = project();
    const seen = join(root, "..", `${root.split("/").pop()}-batch-port`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nports: ${p}-${p + 9}\nland_batch_max: 2\nsetup: 'case $PWD in */batch/*) echo "[$CANON_PORT]" > ${seen};; esac'\n`);
    sh(root, "commit", "-qam", "config");
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    for (const [wt, f] of [[a.worktree, "a.txt"], [b.worktree, "b.txt"]] as const) {
      writeFileSync(join(wt, f), `${f}\n`);
      sh(wt, "add", f);
      sh(wt, "commit", "-qm", f);
    }
    // reason: Bun.spawn without `env` passes the environment the process started with, not later changes to process.env,
    // so the landers run as their own processes started with CANON_PORT set, as an agent's shell would start them.
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const procs: ReturnType<typeof Bun.spawn>[] = [];
    for (const wt of [a.worktree, b.worktree]) {
      procs.push(Bun.spawn(["bun", MAIN, "work", "land"], { cwd: wt, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_PORT: "9999" } }));
      for (let i = 0; i < 400; i++) {
        const e = ws(root).db.db.query<{ state: string }, [string]>("SELECT state FROM queue WHERE worktree = ? ORDER BY id DESC LIMIT 1").get(wt);
        if (e?.state === "waiting") break;
        await Bun.sleep(25);
      }
    }
    finishEntry(other.db, blocker, "landed", "x");
    expect(await Promise.all(procs.map((x) => x.exited))).toEqual([0, 0]);
    expect(events(root, "batch.start").length).toBe(1);
    expect(readFileSync(seen, "utf8").trim()).toBe("[]");
  }, 60_000);
});

describe("ports config", () => {
  const read = (value: string) => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nports: ${value}\n`);
    return readConfig(root);
  };

  test("BR-2268: a <from>-<to> range is read, both ends included; unset means no ports", () => {
    const a = read("4100-4199");
    expect(a.ok && a.value.ports).toEqual({ from: 4100, to: 4199 });
    const b = read('"8080 - 8080"');
    expect(b.ok && b.value.ports).toEqual({ from: 8080, to: 8080 });
    const root = project();
    const c = readConfig(root);
    expect(c.ok && c.value.ports).toBeUndefined();
  });

  test("BR-2268: a reversed, single, out-of-range or non-string value is a config error, exit 2", () => {
    for (const bad of ["4199-4100", "4100", "0-10", "65000-70000", "[4100, 4199]", '"4100-"']) {
      const r = read(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("`ports`");
    }
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nports: 4199-4100\n`);
    const cli = Bun.spawnSync(["bun", MAIN, "check"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr.toString()).toContain("4100-4199");
  });
});

describe("no free port", () => {
  test("BR-2269: a start when every port is held exits 5 naming the holders, records why, and leaves no worktree or claim, with no setup or hook configured", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 1}\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    const cli = Bun.spawnSync(["bun", MAIN, "work", "start", "--title", "C"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:c" } });
    expect(cli.exitCode).toBe(5);
    const msg = cli.stderr.toString();
    for (const x of [`${p}-${p + 1}`, a.value.change, b.value.change]) expect(msg).toContain(x);
    expect(claims(ws(root).db).map((c) => c.subject).sort()).toEqual([a.value.change, b.value.change].sort());
    const wts = sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes(".worktrees/"));
    expect(wts.length).toBe(2);
    expect(events(root, "start.refuse").map((e) => e["reason"])).toEqual(["port"]);
    sh(root, "worktree", "remove", "--force", a.value.worktree);
    expect(start(ws(root), { title: "C again" }, quiet).ok).toBe(true);
  });
});

describe("a hook with no port", () => {
  test("BR-2287: before_land of a change with no port still runs with an empty CANON_PORT and the change lands; after_stop with no free port runs too", async () => {
    const p = base();
    const root = project();
    const s = startNew(root, "Started before ports"); // no ports yet, so no port recorded
    writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nports: ${p}-${p}\nhooks:\n  before_land: 'echo "[$CANON_PORT]" > "$CANON_WORKTREE/../before-land.txt"'\n  after_stop: 'echo "[$CANON_PORT]" > "$CANON_WORKTREE/../after-stop.txt"'\n`);
    sh(root, "commit", "-qam", "ports and hooks");
    expect(start(ws(root, "agent:b"), { title: `Holds ${p}` }, quiet).ok).toBe(true);
    sh(s.worktree, "merge", "-q", "main", "-m", "take config");
    const stopped: string[] = [];
    expect(stop(ws(s.worktree), "later", undefined, false, (l) => stopped.push(l)).ok).toBe(true);
    expect(readFileSync(join(s.worktree, "..", "after-stop.txt"), "utf8").trim()).toBe("[]");
    expect(stopped.join("\n")).toContain("no free port");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (l) => said.push(l));
    expect(out.kind).toBe("landed");
    expect(readFileSync(join(s.worktree, "..", "before-land.txt"), "utf8").trim()).toBe("[]");
    expect(said.join("\n")).toContain("CANON_PORT is empty");
    const runs = events(root, "hook.run");
    expect(runs.map((r) => [r["event"], r["exit"], typeof r["port"]])).toEqual([["after_stop", 0, "string"], ["before_land", 0, "string"]]);
  });

  test("BR-2287: background after_land without a port runs every command and records their own exit codes", async () => {
    const root = project();
    const w = ws(root);
    const lookup = () => err("conflict", "no free port for C-1 in ports 4100-4100");
    const log = runHooksInBackground({ db: w.db, actor: "agent:a", event: "after_land", change: "C-1", cwd: root, env: {}, port: lookup }, ["touch ran.txt", "exit 0"], logFile(w.db, "after-land-1.log"), 1);
    const batch = await waitBackgroundHooks(w.db, "agent:a", "C-1", 10_000, 50);
    expect(existsSync(join(root, "ran.txt"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("CANON_PORT is empty");
    expect(batch?.commands.map((c) => c.exit)).toEqual([0, 0]);
  });

  test("BR-2287: a change with a port says nothing about CANON_PORT and its hook.run events carry no port field", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\nhooks:\n  after_start: 'true'\n`);
    const said: string[] = [];
    expect(start(ws(root), { title: "Has one" }, (l) => said.push(l)).ok).toBe(true);
    expect(said.join("\n")).not.toContain("CANON_PORT is empty");
    expect(events(root, "hook.run").map((r) => "port" in r)).toEqual([false]);
  });
});

describe("choosing a new port", () => {
  test("BR-2288: a port a process outside canon listens on is skipped at first allocation", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 1}\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const l = hold(p);
    try {
      const a = start(ws(root), { title: "A" }, quiet);
      if (!a.ok) throw new Error(a.error.message);
      expect(portFile(a.value.worktree)).toBe(String(p + 1));
      expect(events(root, "port.allocate").map((e) => e["busy"])).toEqual([[p]]);
    } finally {
      l.stop(true);
    }
  });

  test("BR-2288: a freed port its gone worktree's server still holds is not handed out; the start is refused naming it", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 1}\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    sh(root, "worktree", "remove", "--force", a.value.worktree);
    const l = hold(p);
    try {
      const cli = Bun.spawnSync(["bun", MAIN, "work", "start", "--title", "C"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:c" } });
      expect(cli.exitCode).toBe(5);
      expect(cli.stderr.toString()).toContain(`in use by a process outside canon: ${p}`);
    } finally {
      l.stop(true);
    }
  });

  test("BR-2288: freed ports go least recently used first, not lowest first", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 2}\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    planned(root, "C-1");
    const one = start(ws(root), { change: "C-1" }, quiet);
    const two = start(ws(root, "agent:b"), { title: "Two" }, quiet);
    const three = start(ws(root, "agent:c"), { title: "Three" }, quiet);
    if (!one.ok || !two.ok || !three.ok) throw new Error("start failed");
    expect(stop(ws(one.value.worktree), "later", undefined, true).ok).toBe(true);
    expect(start(ws(root), { change: "C-1" }, quiet).ok).toBe(true); // hands p to C-1 again, after p + 1
    sh(root, "worktree", "remove", "--force", one.value.worktree);
    sh(root, "worktree", "remove", "--force", two.value.worktree);
    const four = start(ws(root, "agent:d"), { title: "Four" }, quiet);
    if (!four.ok) throw new Error(four.error.message);
    expect(portFile(four.value.worktree)).toBe(String(p + 1));
  });

  test("BR-2288: a change whose own server holds its port keeps that port when it starts again", () => {
    const p = base();
    const root = configured(`ports: ${p}-${p + 9}\nhooks:\n  after_start: 'echo "$CANON_PORT" >> "$CANON_WORKTREE/../ports.txt"'\n`);
    planned(root, "C-1");
    const s = start(ws(root), { change: "C-1" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    const l = hold(p);
    try {
      expect(stop(ws(s.value.worktree), "later", undefined, true).ok).toBe(true);
      expect(start(ws(root), { change: "C-1" }, quiet).ok).toBe(true);
    } finally {
      l.stop(true);
    }
    expect(readFileSync(join(s.value.worktree, "..", "ports.txt"), "utf8").trim().split("\n")).toEqual([String(p), String(p)]);
  });
});
