import { describe, expect, test } from "bun:test";
import { stopGroups } from "./stop-groups.ts";

/** A shell in a group of its own, running `script`, with the pid of a background child it starts written to `out`. */
function spawnGroup(script: string) {
  return Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
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
    const p = spawnGroup("sleep 30 & wait");
    await Bun.sleep(150);
    const note = await stopGroups([p.pid], () => false);
    expect(note).toBeUndefined();
    expect(alive(p.pid)).toBe(false);
    expect(Bun.spawnSync(["pgrep", "-g", String(p.pid)]).exitCode).not.toBe(0); // nobody left in the group
  });

  test("BR-2304: a group that ignores SIGTERM gets SIGKILL when a second signal comes, without waiting 10 s", async () => {
    const p = spawnGroup('trap "" TERM; sleep 30 & while true; do sleep 0.1; done');
    await Bun.sleep(200);
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
    const p = spawnGroup('trap "" TERM; while true; do sleep 0.1; done');
    await Bun.sleep(200);
    const note = await stopGroups([p.pid], () => false, 400, 3000);
    expect(note).toBe("sent SIGKILL 0.4 s after SIGTERM");
    await p.exited;
  });

  test("BR-2304: with nothing running there is nothing to stop", async () => {
    expect(await stopGroups([], () => false)).toBeUndefined();
  });
});
