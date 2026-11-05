import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANG_SECONDS, runsUntilKilled, waitFor } from "../testkit.ts";
import { stopGroups } from "./stop-groups.ts";

/**
 * A shell in a group of its own, running `script` ($READY is a file it touches once it has set up its traps and
 * started its children), returned once that file exists, so no test guesses how long the shell needs to start.
 */
async function spawnGroup(script: string) {
  const ready = join(mkdtempSync(join(tmpdir(), "canon-stop-groups-")), "ready");
  const p = Bun.spawn(["sh", "-c", script.replaceAll("$READY", ready)], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
  try {
    await waitFor("the shell to be ready", () => existsSync(ready));
  } catch (e) {
    process.kill(-p.pid, "SIGKILL");
    throw e;
  }
  return p;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("canon work test stop", () => {
  test("BR-2304: SIGTERM ends a group and its background children and says nothing", async () => {
    const p = await spawnGroup(`sleep ${HANG_SECONDS} & touch $READY; wait`);
    const note = await stopGroups([p.pid], () => false);
    expect(note).toBeUndefined();
    expect(alive(p.pid)).toBe(false);
    expect(Bun.spawnSync(["pgrep", "-g", String(p.pid)]).exitCode).not.toBe(0); // nobody left in the group
  });

  test("BR-2304: a group that ignores SIGTERM gets SIGKILL when a second signal comes, without waiting 10 s", async () => {
    const p = await spawnGroup(`trap "" TERM; sleep ${HANG_SECONDS} & touch $READY; ${runsUntilKilled}`);
    const t0 = performance.now();
    let hurried = false;
    setTimeout(() => (hurried = true), 300);
    const note = await stopGroups([p.pid], () => hurried);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(note).toBe("sent SIGKILL after a second signal");
    await p.exited;
    expect(Bun.spawnSync(["pgrep", "-g", String(p.pid)]).exitCode).not.toBe(0);
  });

  test("BR-2304: a group that ignores SIGTERM gets SIGKILL once the wait is over", async () => {
    const p = await spawnGroup(`trap "" TERM; touch $READY; ${runsUntilKilled}`);
    const note = await stopGroups([p.pid], () => false, 400, 3000);
    expect(note).toBe("sent SIGKILL 0.4 s after SIGTERM");
    await p.exited;
  });

  test("BR-2304: with nothing running there is nothing to stop", async () => {
    expect(await stopGroups([], () => false)).toBeUndefined();
  });
});
