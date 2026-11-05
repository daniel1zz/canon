import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { land } from "../land/land.ts";
import { enqueue, finishEntry } from "../land/queue/queue.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { fixLandedIn, redMain, startFixMain } from "./redmain.ts";
import { watch } from "./watch.ts";

// reason: a landing in after mode starts the background floor, a spawned `canon floor watch`; these tests wait for it
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project whose main says `config` (floor, floor_timing ...), committed. */
function configured(config: string): string {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `tests: []\n${config}`);
  sh(root, "commit", "-qam", "config");
  return root;
}

const commitFile = (wt: string, path: string, text: string) => {
  writeFileSync(join(wt, path), text);
  sh(wt, "add", path);
  sh(wt, "commit", "-qm", path);
};

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r): Record<string, unknown> => ({ subject: r.subject, ...(JSON.parse(r.detail) as Record<string, unknown>) }));

/** Waits until the background floor has a result for `sha`. */
async function backgroundResult(root: string, sha: string): Promise<string | undefined> {
  for (let i = 0; i < 400; i++) {
    const r = ws(root).db.db.query<{ kind: string }, [string]>("SELECT kind FROM events WHERE kind IN ('floor.pass', 'floor.fail') AND json_extract(detail, '$.sha') = ?").get(sha);
    if (r) return r.kind;
    await Bun.sleep(100);
  }
  return undefined;
}

// reason: an after-mode landing runs the canon on PATH (BR-2224); these tests put their own one first on PATH, so
// they do not depend on what canon this machine has installed.
const FAKE_BIN = mkdtempSync(join(tmpdir(), "canon-fake-bin-"));
const FAKE_CANON = join(FAKE_BIN, "canon");
const fakeCanon = (script: string) => {
  writeFileSync(FAKE_CANON, `#!/bin/sh\n${script}\n`);
  chmodSync(FAKE_CANON, 0o755);
};
const realPath = process.env["PATH"];
beforeAll(() => {
  fakeCanon("exit 0");
  process.env["PATH"] = `${FAKE_BIN}:${realPath}`;
});
afterAll(() => {
  process.env["PATH"] = realPath;
});

describe("landing with floor_timing: after", () => {
  test("BR-2218: a floor that fails does not stop the landing: main moves, land.ok says floor_deferred, the floor is not run, and the background floor starts on the new main", async () => {
    const root = configured("floor: exit 1\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const s = startNew(root, "Deferred");
    commitFile(s.worktree, "new.txt", "x\n");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    const main = sh(root, "rev-parse", "main");
    expect(out.kind === "landed" && out.sha).toBe(main);
    expect(events(root, "land.ok").at(-1)!["floor_deferred"]).toBe(true);
    expect(said.some((m) => m === "floor: exit 1")).toBe(false);
    expect(said).toContain("floor: deferred — floor_timing is after; main is tested in the background once it moves (canon floor watch)");
    const logs = join(dirname(ws(root).db.db.filename), "logs");
    expect(existsSync(join(logs, `land-${events(root, "land.turn").at(-1)!["entry"]}.log`))).toBe(false);
    // The landing started the background floor on the main it made (BR-2219).
    expect(await backgroundResult(root, main)).toBe("floor.fail");
  });

  test("BR-2218: in after mode the change's own steps still refuse: a canon check finding keeps main where it was", async () => {
    const root = configured("floor: exit 1\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Bad ref");
    writeFileSync(join(s.worktree, "canon/changes/C-1-bad-ref.md"), "---\nid: C-1\ntitle: Bad ref\n---\n## 为什么\n\nSee D-99.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n");
    sh(s.worktree, "commit", "-qam", "dangling");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "floor.pass").length + events(root, "floor.fail").length).toBe(0);
  });

  test("BR-2218: with floor_timing before, or unset, a failing floor refuses the landing and main stays", async () => {
    for (const config of ["floor: exit 1\nfloor_timing: before\n", "floor: exit 1\n"]) {
      const root = configured(config);
      const before = sh(root, "rev-parse", "main");
      const s = startNew(root, "Tested first");
      commitFile(s.worktree, "new.txt", "x\n");
      const out = await land(ws(s.worktree), FAST, quiet);
      expect([config, out.kind === "refused" && out.reason]).toEqual([config, "floor"]);
      expect(sh(root, "rev-parse", "main")).toBe(before);
    }
  });

  test("BR-2218: floor_timing other than before or after makes every command exit 2", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nfloor_timing: sometimes\n");
    for (const args of [["work", "status"], ["check"], ["floor", "watch"]]) {
      const r = canon(root, ...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
      expect(r.err).toContain("floor_timing");
    }
  });

  test("BR-2218: three landings waiting in after mode land one by one; no batch is formed", async () => {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\nland_batch_max: 4\n");
    const wts = ["A", "B", "C"].map((t) => {
      const s = startNew(root, t);
      commitFile(s.worktree, `${t}.txt`, `${t}\n`);
      return s.worktree;
    });
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const runs: Promise<Awaited<ReturnType<typeof land>>>[] = [];
    for (const wt of wts) {
      runs.push(land(ws(wt), FAST, quiet));
      for (let n = 0; n < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(wt); n++) await Bun.sleep(10);
    }
    finishEntry(other.db, blocker, "landed", "x");
    const out = await Promise.all(runs);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed", "landed"]);
    expect(events(root, "batch.start")).toEqual([]);
    const oks = events(root, "land.ok");
    expect(oks.map((o) => [o["floor_deferred"], o["batched_by"], o["batch"]])).toEqual([
      [true, undefined, undefined],
      [true, undefined, undefined],
      [true, undefined, undefined],
    ]);
    expect(await backgroundResult(root, sh(root, "rev-parse", "main"))).toBe("floor.pass");
  });
});

describe("the canon on PATH reads the landing's config in after mode", () => {
  test("BR-2224: a PATH canon that cannot read the config refuses the landing with reason config, naming its path, exit code and error; main stays", async () => {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New key");
    commitFile(s.worktree, "new.txt", "x\n");
    fakeCanon("echo \"canon: canon/config.yaml: unknown key \\`brand_new\\`\" >&2; exit 2");
    try {
      const out = await land(ws(s.worktree), FAST, quiet);
      expect(out.kind === "refused" && out.reason).toBe("config");
      const message = out.kind === "refused" ? out.message : "";
      expect(message).toContain(FAKE_CANON);
      expect(message).toContain("exited 2");
      expect(message).toContain("unknown key");
      expect(sh(root, "rev-parse", "main")).toBe(before);
      expect(events(root, "land.refuse").at(-1)).toMatchObject({ reason: "config", floor_deferred: true });
    } finally {
      fakeCanon("exit 0");
    }
  });

  test("BR-2224: a PATH canon that reads the config lets the landing go ahead", async () => {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const s = startNew(root, "Fine");
    commitFile(s.worktree, "new.txt", "x\n");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
  });

  test("BR-2224: no canon on PATH refuses the landing with reason config", async () => {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "No canon");
    commitFile(s.worktree, "new.txt", "x\n");
    const w = ws(s.worktree);
    // reason: git and sh are in /usr/bin and /bin, canon is not
    process.env["PATH"] = "/usr/bin:/bin";
    try {
      const out = await land(w, FAST, quiet);
      expect(out.kind === "refused" && out.reason).toBe("config");
      expect(out.kind === "refused" ? out.message : "").toContain("canon is not on PATH");
    } finally {
      process.env["PATH"] = `${FAKE_BIN}:${realPath}`;
    }
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2224: with floor_timing before the PATH canon is not run; the floor decides", async () => {
    const root = configured("floor: test ! -e FAIL\n");
    const s = startNew(root, "Before");
    commitFile(s.worktree, "new.txt", "x\n");
    fakeCanon("exit 2");
    try {
      const out = await land(ws(s.worktree), FAST, quiet);
      expect(out.kind).toBe("landed");
    } finally {
      fakeCanon("exit 0");
    }
  });
});

describe("landing while main is failing", () => {
  /** A project in after mode whose main fails its floor, with the failure recorded by a background run. */
  async function redProject() {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    writeFileSync(join(root, "FAIL"), "x\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "broken");
    expect((await watch(ws(root), quiet)).ok).toBe(true);
    return root;
  }

  test("BR-2306: a landing that succeeds says main is failing and that nobody is fixing it, with the --fix-main hint", async () => {
    const root = await redProject();
    const s = startNew(root, "Lands on red");
    commitFile(s.worktree, "new.txt", "x\n");
    const r = canon(s.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out).toContain("main is failing floor since");
    expect(r.out).toContain("nobody is fixing it yet");
    expect(r.out).toContain("canon work start --fix-main");
  });

  test("BR-2306: with a fix change on the record the landing names it", async () => {
    const root = await redProject();
    expect(canon(root, "work", "start", "--fix-main").code).toBe(0);
    const fix = redMain(ws(root).db)!.change!;
    const s = startNew(root, "Lands beside the fix");
    commitFile(s.worktree, "new.txt", "x\n");
    const r = canon(s.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`being fixed in ${fix}`);
  });

  test("BR-2306: with --finish the two lines come before the lessons reminder, which stays last", async () => {
    const root = await redProject();
    const s = startNew(root, "Finishes on red");
    commitFile(s.worktree, "new.txt", "x\n");
    const r = canon(s.worktree, "work", "land", "--finish");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines.at(-1)).toStartWith("lessons:");
    expect(lines.findIndex((l) => l.startsWith("main is failing floor since"))).toBeLessThan(lines.length - 1);
    expect(lines.some((l) => l.includes("nobody is fixing it yet"))).toBe(true);
  });

  test("BR-2306: a refused landing says it too, on stderr, with the exit code unchanged", async () => {
    const root = await redProject();
    const s = startNew(root, "Refused on red");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    const r = canon(s.worktree, "work", "land");
    expect(r.code).toBe(2);
    expect(r.err).toContain("land refused (dirty)");
    expect(r.err).toContain("main is failing floor since");
    expect(r.err).toContain("nobody is fixing it yet");
  });

  test("BR-2306: when main is not failing nothing is added", async () => {
    const root = configured("floor: test ! -e FAIL\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
    const s = startNew(root, "Lands on green");
    commitFile(s.worktree, "new.txt", "x\n");
    const r = canon(s.worktree, "work", "land");
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("main is failing");
  });

  test("BR-2220, BR-2221: once the fix change has landed and the floor fails again on a commit with it, the record no longer names it and --fix-main opens another", async () => {
    const root = await redProject();
    const started = startFixMain(ws(root), quiet);
    if (!started.ok) throw new Error(started.error.message);
    const first = started.value.change;
    // The fix is not enough: FAIL stays. Its change file gets the sections a landing requires.
    const dir = join(started.value.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${first}-`) || f === `${first}.md`)!);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `${text.slice(0, text.indexOf("---\n", 4) + 4)}\n## 为什么\n\nfix.\n\n## 要改什么\n\nfix.\n\n## 教训\n\n无。\n\n## 任务\n\n- [ ] fix\n`);
    sh(started.value.worktree, "commit", "-q", "--amend", "--no-edit", "-a");
    commitFile(started.value.worktree, "partial.txt", "x\n");
    const out = await land(ws(started.value.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    expect(await backgroundResult(root, sh(root, "rev-parse", "main"))).toBe("floor.fail");
    expect(redMain(ws(root).db)!.change).toBeNull();
    const again = canon(root, "work", "start", "--fix-main");
    expect(again.code).toBe(0);
    expect(redMain(ws(root).db)!.change).not.toBe(first);
  });

  test("BR-2221: a fix change that has not landed, or whose landing the failing commit does not contain, stays on the record", async () => {
    const root = await redProject();
    const started = startFixMain(ws(root), quiet);
    if (!started.ok) throw new Error(started.error.message);
    const fix = started.value.change;
    const w = ws(root);
    const older = sh(root, "rev-parse", "main");
    expect(fixLandedIn(w, older)).toBe(false);
    writeFileSync(join(root, "second.txt"), "x\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "second");
    const landed = sh(root, "rev-parse", "main");
    w.db.event(w.actor, "land.ok", fix, { sha: landed });
    expect(fixLandedIn(w, older)).toBe(false);
    expect(fixLandedIn(w, landed)).toBe(true);
    expect(redMain(w.db)!.change).toBe(fix);
  });
});
