import { describe, expect, test } from "bun:test";
import { noPort } from "./ports.ts";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../session/session.ts";
import { readConfig } from "../../config/config.ts";
import { logFile, runHooks, runHooksInBackground, runHooksSync, waitBackgroundHooks, type HookContext } from "./hooks.ts";
import { project, quiet, sh, startNew, ws } from "../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

function ctxFor(root: string, event: HookContext["event"] = "after_start"): HookContext {
  return { db: ws(root).db, actor: "agent:a", event, change: "C-1", cwd: root, env: {}, port: noPort };
}

/** What runHooksSync prints for these commands. */
function printed(root: string, commands: string[], event: HookContext["event"] = "after_start"): string[] {
  const lines: string[] = [];
  runHooksSync(ctxFor(root, event), commands, (l) => lines.push(l));
  return lines;
}

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

describe("hooks config", () => {
  const read = (yaml: string) => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), yaml);
    return readConfig(root);
  };

  test("BR-2198: an event takes one command or a list of them; null, {} and [] mean no commands", () => {
    const one = read('hooks:\n  after_land: "bun run build"\n');
    expect(one.ok && one.value.hooks.after_land).toEqual(["bun run build"]);
    const two = read('hooks:\n  after_land: ["bun run build", "bun run notify"]\n');
    expect(two.ok && two.value.hooks.after_land).toEqual(["bun run build", "bun run notify"]);
    for (const yaml of ["hooks: null\n", "hooks: {}\n", "hooks:\n  after_start: []\n"]) {
      const r = read(yaml);
      expect([yaml, r.ok && Object.values(r.value.hooks).flat()]).toEqual([yaml, []]);
    }
    const green = read('hooks:\n  after_green: "bun run build"\n');
    expect(green.ok && green.value.hooks.after_green).toEqual(["bun run build"]);
    const quoted = read('hooks:\n  after_start: ["true"]\n');
    expect(quoted.ok && quoted.value.hooks.after_start).toEqual(["true"]);
  });

  test("BR-2198: anything else is a config error that names the event, and every command exits 2", () => {
    const cases: [string, string][] = [
      ["hooks: [x]\n", "`hooks` must be a mapping"],
      ["hooks:\n  before_start: x\n", "unknown hook event `before_start`"],
      ['hooks:\n  after_start: ""\n', "`hooks.after_start`"],
      ['hooks:\n  after_start: "  "\n', "`hooks.after_start`"],
      ["hooks:\n  after_start: null\n", "`hooks.after_start`"],
      ["hooks:\n  after_start: [true]\n", "`hooks.after_start`"],
      ["hooks:\n  after_start: 3\n", "`hooks.after_start`"],
      ["hooks:\n  after_start: {a: b}\n", "`hooks.after_start`"],
    ];
    for (const [yaml, message] of cases) {
      const root = project();
      writeFileSync(join(root, "canon/config.yaml"), yaml);
      const r = Bun.spawnSync(["bun", MAIN, "show", ["C", 1].join("-")], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      expect([yaml, r.exitCode, r.stderr.toString().includes(message)]).toEqual([yaml, 2, true]);
    }
  });
});

describe("how a hook command runs", () => {
  test("BR-2199: after_start gets CANON_ACTOR and CANON_WORKTREE of the change it started", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  after_start: 'echo "$CANON_ACTOR $CANON_WORKTREE" > who.txt'\n`);
    sh(root, "commit", "-qam", "hook");
    const r = start(ws(root, "agent:a"), { title: "Who" }, quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(readFileSync(join(r.value.worktree, "who.txt"), "utf8").trim()).toBe(`agent:a ${r.value.worktree}`);
  });

  test("BR-2199: every event sets CANON_EVENT, CANON_CHANGE and CANON_PORT, keeps the caller's environment, and canon's values win", () => {
    const root = project();
    withEnv({ CANON_HOOK_TEST_FOO: "1", CANON_EVENT: "x", CANON_PORT: "9999" }, () =>
      printed(root, ['echo "$CANON_EVENT" > e.txt', 'echo "$CANON_HOOK_TEST_FOO" > foo.txt', 'echo "$CANON_CHANGE" > c.txt', 'printf "[%s]" "$CANON_PORT" > p.txt'], "after_stop"),
    );
    expect(["e.txt", "foo.txt", "c.txt", "p.txt"].map((f) => readFileSync(join(root, f), "utf8").trim())).toEqual(["after_stop", "1", "C-1", "[]"]);
    runHooksSync({ ...ctxFor(root), change: null }, ['printf "[%s]" "$CANON_CHANGE" > none.txt'], quiet);
    expect(readFileSync(join(root, "none.txt"), "utf8")).toBe("[]");
  });

  test("BR-2199: standard input is empty, so a command reading it ends at once", () => {
    const root = project();
    const t0 = Date.now();
    printed(root, ["cat; echo done > done.txt"]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(readFileSync(join(root, "done.txt"), "utf8").trim()).toBe("done");
  });
});

describe("what a foreground hook prints", () => {
  test("BR-2200: each command is announced, then its output indented by two spaces", () => {
    const root = project();
    expect(printed(root, ["echo hi"])).toEqual(["hook after_start: echo hi", "  hi"]);
    expect(printed(root, ["echo oops >&2"])).toEqual(["hook after_start: echo oops >&2", "  oops"]);
    expect(printed(root, ["true"])).toEqual(["hook after_start: true"]);
  });

  test("BR-2200: only the last 40 lines of the output are printed", () => {
    const root = project();
    const many = printed(root, ["seq 1 45"]);
    expect(many.slice(1)).toEqual(Array.from({ length: 40 }, (_, i) => `  ${i + 6}`));
    const forty = printed(root, ["seq 1 40"]);
    expect(forty.slice(1)).toEqual(Array.from({ length: 40 }, (_, i) => `  ${i + 1}`));
  });

  test("BR-2200: stdout and stderr lines are printed in the order the command wrote them, by both runners", async () => {
    const root = project();
    const command = "echo a; echo b >&2; echo c";
    const expected = [`hook after_start: ${command}`, "  a", "  b", "  c"];
    expect(printed(root, [command])).toEqual(expected);
    const lines: string[] = [];
    await runHooks(ctxFor(root, "before_land"), [command], (l) => lines.push(l), true);
    expect(lines).toEqual([`hook before_land: ${command}`, "  a", "  b", "  c"]);
  });

  test("BR-2200: a non-zero exit of after_stop is said and changes nothing", () => {
    const root = project();
    expect(printed(root, ["exit 5"], "after_stop")).toEqual(["hook after_stop: exit 5", "hook after_stop exited 5; the result is unchanged"]);
  });
});

describe("background after_land commands", () => {
  test("BR-2201: each command runs in its own subshell: a cd, a variable or an exit does not reach the next", async () => {
    const root = project();
    const w = ws(root);
    const log = runHooksInBackground(ctxFor(root, "after_land"), ['cd / && X=1 && exit 3', 'pwd; echo "x=$X"'], logFile(w.db, "after-land-1.log"), 1);
    const b = await waitBackgroundHooks(w.db, "agent:test", undefined, 10_000, 50);
    expect(b?.commands.map((c) => c.exit)).toEqual([3, 0]);
    const text = readFileSync(log, "utf8");
    expect(text).toContain(`${realpathSync(root)}\nx=\n[hook 2/2 exited 0]`);
  });

  test("BR-2201: output and exit lines go to the log in order", async () => {
    const root = project();
    const w = ws(root);
    const log = runHooksInBackground(ctxFor(root, "after_land"), ["echo one", "echo two >&2"], logFile(w.db, "after-land-2.log"), 2);
    await waitBackgroundHooks(w.db, "agent:test", undefined, 10_000, 50);
    expect(existsSync(log) && readFileSync(log, "utf8")).toBe("one\n[hook 1/2 exited 0]\ntwo\n[hook 2/2 exited 0]\n");
  });
});

describe("before_land through the CLI", () => {
  test("BR-2057: a failing before_land makes canon work land exit 1 with main unchanged", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  before_land: test -e CHANGELOG.md\n`);
    sh(root, "commit", "-qam", "hook");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "No changelog");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const r = Bun.spawnSync(["bun", MAIN, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(r.exitCode).toBe(1);
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });
});
