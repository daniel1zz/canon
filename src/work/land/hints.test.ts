import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueue, tryTurn } from "./queue/queue.ts";
import { land } from "./land.ts";
import { FAST, project, sh, startNew, ws } from "../testkit.ts";

// reason: each case lands a change in process; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

function committed(root: string, title: string) {
  const s = startNew(root, title);
  writeFileSync(join(s.worktree, "x.txt"), `${title}\n`);
  sh(s.worktree, "add", "x.txt");
  sh(s.worktree, "commit", "-qm", title);
  return s;
}

describe("what a landing says at the moment a session needs it (BR-2654, D-169)", () => {
  test("BR-2654: the first time a landing waits it says it goes on in the background and how to follow or stop it; later waiting lines do not repeat it", async () => {
    const root = project();
    const s = committed(root, "Waits");
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, blocker).mine).toBe(true);
    const said: string[] = [];
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 300 }, (l) => said.push(l));
    expect(out.kind).toBe("timeout");
    const waiting = said.filter((l) => l.startsWith("waiting: "));
    expect(waiting[0]).toBe("waiting: 1 landing(s) ahead; the landing goes on in the background: a timeout or Ctrl-C only stops following it, canon work land again follows it, --stop stops it");
    expect(waiting.slice(1).every((l) => !l.includes("background"))).toBe(true);
  });

  test("BR-2654: a landed change is told to follow its post-land commands with canon work after-land --wait <C-n>", async () => {
    const root = project();
    const s = committed(root, "Lands");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (l) => said.push(l));
    expect(out.kind).toBe("landed");
    expect(said).toContain(`post-land commands and the rule review run in the background: canon work after-land --wait ${s.change} reports them; do not poll the log`);
  });
});
