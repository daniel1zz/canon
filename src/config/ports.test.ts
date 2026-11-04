import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims } from "../work/claims/claims.ts";
import { start, stop } from "../work/session/session.ts";
import { land } from "../work/land/land.ts";
import { readConfig } from "./config.ts";
import { logFile, runHooksInBackground, waitBackgroundHooks } from "./hooks.ts";
import { err } from "../kernel/result.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../work/testkit.ts";

// reason: these tests start real worktrees and run setup and hooks as shells (C-111).
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

function configured(yaml: string) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\n${yaml}`);
  sh(root, "commit", "-qam", "config");
  return root;
}

const portFile = (wt: string, name = "port.txt") => readFileSync(join(wt, name), "utf8").trim();

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A change file on main, so `canon work start C-n` has something to start. */
function planned(root: string, id: string) {
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  writeFileSync(join(root, `canon/changes/${id}.md`), `---\nid: ${id}\ntitle: Planned ${id}\nstatus: open\n---\n## 为什么\n\nPlanned.\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", `plan ${id}`);
}

describe("CANON_PORT", () => {
  test("BR-2267: setup sees the change's port; each new change gets the lowest free one", () => {
    const root = configured(`ports: 4100-4199\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(portFile(a.value.worktree)).toBe("4100");
    expect(portFile(b.value.worktree)).toBe("4101");
  });

  test("BR-2267: the same change keeps its port across start, stop and starting again, in every hook", () => {
    const root = configured(`ports: 4100-4199\nhooks:\n  after_start: 'echo "$CANON_PORT" >> "$CANON_WORKTREE/../ports.txt"'\n  after_stop: 'echo "$CANON_PORT" >> "$CANON_WORKTREE/../ports.txt"'\n`);
    planned(root, "C-1");
    start(ws(root, "agent:other"), { title: "Takes 4100 first" }, quiet);
    const s = start(ws(root), { change: "C-1" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    expect(stop(ws(s.value.worktree), "later", undefined, true).ok).toBe(true);
    expect(start(ws(root), { change: "C-1" }, quiet).ok).toBe(true);
    const lines = readFileSync(join(s.value.worktree, "..", "ports.txt"), "utf8").trim().split("\n");
    expect(lines).toEqual(["4100", "4101", "4101", "4101"]);
  });

  test("BR-2267: 8 concurrent CLI starts get 8 different ports, all within the range", async () => {
    const root = configured(`ports: 4100-4199\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", MAIN, "work", "start", "--title", `Parallel ${i}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: `agent:p${i}` } }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual(Array(8).fill(0));
    const ports = claims(ws(root).db).map((c) => Number(portFile(c.holder)));
    expect(new Set(ports).size).toBe(8);
    expect(ports.every((p) => p >= 4100 && p <= 4199)).toBe(true);
  }, 60_000);

  test("BR-2267: a port whose change's worktree is gone goes to the next change", () => {
    const root = configured(`ports: 4100-4101\nsetup: 'echo "$CANON_PORT" > port.txt'\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    sh(root, "worktree", "remove", "--force", a.value.worktree);
    const c = start(ws(root), { title: "C" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    expect(portFile(c.value.worktree)).toBe("4100");
  });

  test("BR-2267: without ports, CANON_PORT is empty and an inherited CANON_PORT is not passed on", () => {
    const root = configured(`setup: 'echo "[$CANON_PORT]" > port.txt'\nhooks:\n  after_start: 'echo "[$CANON_PORT]" > hook.txt'\n`);
    const s = withEnv({ CANON_PORT: "9999" }, () => start(ws(root), { title: "No ports" }, quiet));
    if (!s.ok) throw new Error(s.error.message);
    expect(portFile(s.value.worktree)).toBe("[]");
    expect(portFile(s.value.worktree, "hook.txt")).toBe("[]");
  });

  test("BR-2267: after the range changes, the change's next hook gets a port in the new range", () => {
    const root = configured(`ports: 4100-4199\nhooks:\n  after_stop: 'echo "$CANON_PORT" > "$CANON_WORKTREE/../stop.txt"'\n`);
    const s = start(ws(root), { title: "Moves" }, quiet);
    if (!s.ok) throw new Error(s.error.message);
    writeFileSync(join(s.value.worktree, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nports: 5000-5099\nhooks:\n  after_stop: 'echo "$CANON_PORT" > "$CANON_WORKTREE/../stop.txt"'\n`);
    expect(stop(ws(s.value.worktree), "later", undefined, false).ok).toBe(true);
    expect(readFileSync(join(s.value.worktree, "..", "stop.txt"), "utf8").trim()).toBe("5000");
  });
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
  test("BR-2269: a start when every port is held exits 5 naming the holders, and leaves no worktree or claim", () => {
    const root = configured(`ports: 4100-4101\n`);
    const a = start(ws(root), { title: "A" }, quiet);
    const b = start(ws(root), { title: "B" }, quiet);
    if (!a.ok || !b.ok) throw new Error("start failed");
    const cli = Bun.spawnSync(["bun", MAIN, "work", "start", "--title", "C"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:c" } });
    expect(cli.exitCode).toBe(5);
    const msg = cli.stderr.toString();
    for (const s of ["4100-4101", a.value.change, b.value.change]) expect(msg).toContain(s);
    expect(claims(ws(root).db).map((c) => c.subject).sort()).toEqual([a.value.change, b.value.change].sort());
    const wts = sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes(".worktrees/"));
    expect(wts.length).toBe(2);
    sh(root, "worktree", "remove", "--force", a.value.worktree);
    expect(start(ws(root), { title: "C again" }, quiet).ok).toBe(true);
  });

  test("BR-2269: before_land of a change with no port and no free one refuses the landing without running", async () => {
    const root = project();
    const s = startNew(root, "Started before ports"); // no ports yet, so no port recorded
    writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\nports: 4100-4100\nhooks:\n  before_land: 'touch "$CANON_WORKTREE/../before-land-ran"'\n  after_stop: 'touch "$CANON_WORKTREE/../after-stop-ran"'\n`);
    sh(root, "commit", "-qam", "ports and hooks");
    expect(start(ws(root, "agent:b"), { title: "Holds 4100" }, quiet).ok).toBe(true);
    sh(s.worktree, "merge", "-q", "main", "-m", "take config");
    const before = sh(root, "rev-parse", "main");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("hook");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(existsSync(join(s.worktree, "..", "before-land-ran"))).toBe(false);
    const lines: string[] = [];
    expect(stop(ws(s.worktree), "later", undefined, false, (l) => lines.push(l)).ok).toBe(true);
    expect(existsSync(join(s.worktree, "..", "after-stop-ran"))).toBe(false);
    expect(lines.join("\n")).toContain("no free port");
    const runs = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'hook.run'").all().map((e) => JSON.parse(e.detail));
    expect(runs.map((r) => [r.event, r.command, r.exit, typeof r.port])).toEqual([["before_land", null, 1, "string"], ["after_stop", null, 1, "string"]]);
  });

  test("BR-2269: background after_land without a port runs none of its commands and reports each as exited 1", async () => {
    const root = project();
    const w = ws(root);
    const lookup = () => err("conflict", "no free port for C-1 in ports 4100-4100");
    const log = runHooksInBackground({ db: w.db, actor: "agent:a", event: "after_land", change: "C-1", cwd: root, env: {}, port: lookup }, ["touch ran.txt", "exit 0"], logFile(w.db, "after-land-1.log"), 1);
    const batch = await waitBackgroundHooks(w.db, "agent:a", "C-1", 10_000, 50);
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("no free port");
    expect(batch?.commands.map((c) => c.exit)).toEqual([1, 1]);
  });
});
