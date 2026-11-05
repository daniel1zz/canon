import { describe, expect, test } from "bun:test";
import { noPort } from "./ports.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { logFile, runHooksInBackground, waitBackgroundHooks } from "./hooks.ts";
import { project, ws } from "../work/testkit.ts";

const MAIN = join(import.meta.dir, "../cli/main.ts");

function afterLand(cwd: string) {
  const r = Bun.spawnSync(["bun", MAIN, "work", "after-land"], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

async function batch(root: string, change: string, entry: number, commands: string[], settle: boolean) {
  const w = ws(root);
  runHooksInBackground({ db: w.db, actor: "agent:a", event: "after_land", change, cwd: root, env: {}, port: noPort }, commands, logFile(w.db, `after-land-${entry}.log`), entry);
  if (settle) await waitBackgroundHooks(w.db, "agent:test", change, 10_000, 50);
}

describe("canon work after-land verdicts", () => {
  test("BR-2166: the second command failing after the first exited 0 is exit 1, finished; some failed", async () => {
    const root = project();
    await batch(root, "C-5", 5, ["exit 0", "exit 1"], true);
    const r = afterLand(root);
    expect(r.code).toBe(1);
    expect(r.out.split("\n")[0]).toEndWith(": finished; some failed");
    expect(r.out).toContain("[2/2] exit 1: exited 1");
  });

  test("BR-2166: a failure while another command still runs is exit 1, failed; others still running", async () => {
    const root = project();
    await batch(root, "C-6", 6, ["exit 2", `while [ ! -e ${root}/go ]; do sleep 0.05; done`], false);
    let r = afterLand(root);
    for (let i = 0; i < 200 && !r.out.includes("exited 2"); i++) {
      await Bun.sleep(25);
      r = afterLand(root);
    }
    expect(r.code).toBe(1);
    expect(r.out.split("\n")[0]).toEndWith(": failed; others still running");
    expect(r.out).toContain("[2/2]");
    expect(r.out).toContain("still running");
    writeFileSync(join(root, "go"), "");
  });
});
