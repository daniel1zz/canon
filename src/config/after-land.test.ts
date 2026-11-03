import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logFile, runHooksInBackground } from "./hooks.ts";
import { project, ws } from "../work/testkit.ts";

// reason: these tests spawn the canon CLI and real background shells, which is what they test (C-111).
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "../cli/main.ts");

function afterLand(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, "work", "after-land", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

async function finished(log: string, n: number) {
  for (let i = 0; i < 400; i++) {
    if (existsSync(log) && (readFileSync(log, "utf8").match(/^\[hook \d+\/\d+ exited \d+\]$/gm) ?? []).length >= n) return;
    await Bun.sleep(25);
  }
  throw new Error(`${log} never showed ${n} exit lines`);
}

function background(root: string, change: string, entry: number, commands: string[]) {
  const w = ws(root);
  return runHooksInBackground({ db: w.db, actor: "agent:a", event: "after_land", change, cwd: root, env: {} }, commands, logFile(w.db, `after-land-${entry}.log`), entry);
}

const exitEvents = (root: string) => ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'hook.exit'").get()!.n;

describe("canon work after-land", () => {
  test("BR-2166: each command's exit code and the code-review lines; exit 0 when all exited 0; hook.exit recorded once", async () => {
    const root = project();
    const log = background(root, "C-5", 5, ["true", "echo 'code-review: no findings'; echo unrelated-line"]);
    await finished(log, 2);
    const r = afterLand(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`after_land after C-5 (log: ${log}): all finished, all exited 0`);
    expect(r.out).toContain("  [1/2] true: exited 0");
    expect(r.out).toContain("exited 0\ncode-review: no findings");
    expect(r.out.split("\n")).not.toContain("unrelated-line");
    expect(exitEvents(root)).toBe(2);
    afterLand(root);
    expect(exitEvents(root)).toBe(2);
    const j = JSON.parse(afterLand(root, "--json").out) as { state: string; review: string[]; commands: { exit: number }[] };
    expect([j.state, j.review, j.commands.map((c) => c.exit)]).toEqual(["ok", ["code-review: no findings"], [0, 0]]);
  });

  test("BR-2166: exit 1 when a command failed, also while the next still runs; 75 while running without a failure", async () => {
    const root = project();
    const log = background(root, "C-3", 3, ["exit 2", `while [ ! -e ${root}/go ]; do sleep 0.05; done`]);
    await finished(log, 1);
    const r = afterLand(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("[1/2] exit 2: exited 2");
    expect(r.out).toContain("still running");
    writeFileSync(join(root, "go"), "");
    await finished(log, 2);
    expect(afterLand(root).code).toBe(1);

    const slow = background(root, "C-4", 4, [`while [ ! -e ${root}/go2 ]; do sleep 0.05; done`, "true"]);
    const running = afterLand(root);
    expect(running.code).toBe(75);
    expect(running.out).toContain("not finished yet");
    writeFileSync(join(root, "go2"), "");
    await finished(slow, 2);
    expect(afterLand(root).code).toBe(0);
  });

  test("BR-2166: a named change reports its own latest landing; none is 3; a missing log is 4", async () => {
    const root = project();
    expect(afterLand(root).code).toBe(3);
    const four = background(root, "C-4", 4, ["exit 9"]);
    const five = background(root, "C-5", 5, ["true"]);
    await finished(four, 1);
    await finished(five, 1);
    expect(afterLand(root).code).toBe(0);
    const named = afterLand(root, "C-4");
    expect([named.code, named.out.includes("after C-4")]).toEqual([1, true]);
    expect(afterLand(root, "C-999").code).toBe(3);
    rmSync(five);
    const gone = afterLand(root);
    expect([gone.code, gone.out.includes("the log is missing")]).toEqual([4, true]);
  });

  test("BR-2167: --wait waits for every command, through a failure; it stops at the timeout with 75", async () => {
    const root = project();
    background(root, "C-1", 1, ["exit 2", "sleep 0.3"]);
    const waited = afterLand(root, "--wait");
    expect(waited.code).toBe(1);
    expect(waited.out).toContain("[1/2] exit 2: exited 2");
    expect(waited.out).toContain("[2/2] sleep 0.3: exited 0");

    background(root, "C-2", 2, [`while [ ! -e ${root}/go ]; do sleep 0.05; done`]);
    const t0 = Date.now();
    const timedOut = afterLand(root, "--wait", "--timeout", "0.01");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(timedOut.code).toBe(75);
    expect(timedOut.out).toContain("still running after 0.01 min");
    writeFileSync(join(root, "go"), "");
  });

  test("BR-2167: --timeout must be a positive number and needs --wait", () => {
    const root = project();
    for (const bad of [["--wait", "--timeout", "0"], ["--wait", "--timeout", "abc"], ["--timeout", "5"]]) expect(afterLand(root, ...bad).code).toBe(2);
  });
});
