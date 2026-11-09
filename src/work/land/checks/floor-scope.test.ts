import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { readConfig } from "../../../invocation/config.ts";
import { batchCandidates, enter, landsBefore, tryTurn } from "../queue/queue.ts";
import { selfProcess } from "../../claims/liveness.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

/**
 * A project whose full floor fails and whose `tools` scope passes, so the outcome says which one ran.
 * test_select_command selects tools/tests/a_test.py for a change under tools/, and also game/tests/b_test.py when the
 * changed path names `reads-game`.
 */
const CONFIG = [
  'floor: "false"',
  'tests: ["tools/tests/*_test.py", "game/tests/*_test.py"]',
  "floor_skip_paths: [canon/changes]",
  "floor_scopes:",
  "  - paths: [tools]",
  '    command: "true"',
  "test_select_command: \"sh select.sh\"",
  "",
].join("\n");
const SELECT = 'paths=$(cat)\ncase "$paths" in *tools/*) printf "tools/tests/a_test.py\\ttools\\n";; esac\ncase "$paths" in *reads-game*) printf "game/tests/b_test.py\\treads it\\n";; esac\n';

function scoped(config = CONFIG) {
  const root = project();
  mkdirSync(join(root, "tools/tests"), { recursive: true });
  mkdirSync(join(root, "game/tests"), { recursive: true });
  writeFileSync(join(root, "tools/tests/a_test.py"), "# a\n");
  writeFileSync(join(root, "game/tests/b_test.py"), "# b\n");
  writeFileSync(join(root, "select.sh"), SELECT);
  writeFileSync(join(root, "canon/config.yaml"), config);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "scoped config");
  return root;
}
const commitFile = (wt: string, path: string, text: string) => {
  mkdirSync(join(wt, path, ".."), { recursive: true });
  writeFileSync(join(wt, path), text);
  sh(wt, "add", path);
  sh(wt, "commit", "-qm", path);
};
const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail) as Record<string, unknown>);

describe("floor scopes (D-82)", () => {
  test("BR-2398: a landing that changes only paths of a floor scope runs that scope's command instead of the floor, says so and records floor.scope", async () => {
    const root = scoped();
    const s = startNew(root, "Tooling");
    commitFile(s.worktree, "tools/devlog.py", "print(1)\n");
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    expect(said.some((l) => l.startsWith("floor: scoped — every changed path is under floor_scopes entry 1 (tools)"))).toBe(true);
    expect(events(root, "floor.scope")).toMatchObject([{ scope: ["tools"] }]);
    expect(events(root, "queue.enter")).toMatchObject([{ scoped: true }]);
  });

  test("BR-2398: a path outside the scope, or a selected test outside it, runs the whole floor", async () => {
    const outside = scoped();
    const a = startNew(outside, "Game too");
    commitFile(a.worktree, "tools/devlog.py", "print(1)\n");
    commitFile(a.worktree, "game/main.gd", "x\n");
    const r1 = await land(ws(a.worktree), FAST, quiet);
    expect(r1.kind === "refused" && r1.reason).toBe("floor");
    expect(events(outside, "floor.scope")).toEqual([]);

    const selected = scoped();
    const b = startNew(selected, "Read by a game test");
    commitFile(b.worktree, "tools/reads-game.py", "print(2)\n");
    const said: string[] = [];
    const r2 = await land(ws(b.worktree), FAST, (l) => said.push(l));
    expect(r2.kind === "refused" && r2.reason).toBe("floor");
    expect(said.some((l) => l.startsWith("floor scope not used: test_select_command selects 1 test file(s) outside tools: game/tests/b_test.py"))).toBe(true);
  });

  test("BR-2398: a failing scope command refuses with reason floor", async () => {
    const root = scoped(CONFIG.replace('command: "true"', 'command: "false"'));
    const s = startNew(root, "Broken tool");
    commitFile(s.worktree, "tools/devlog.py", "print(1)\n");
    const r = await land(ws(s.worktree), FAST, quiet);
    expect(r.kind === "refused" && r.reason).toBe("floor");
  });

  test("BR-2398: floor_scopes without test_select_command, or with a path covering canon/config.yaml, is a config error", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\nfloor_scopes:\n  - paths: [tools]\n    command: "true"\n');
    const r1 = readConfig(root);
    expect(!r1.ok && r1.error.code).toBe("invalid");
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntest_select_command: "true"\nfloor_scopes:\n  - paths: [canon/config.yaml]\n    command: "true"\n');
    const r2 = readConfig(root);
    expect(!r2.ok && r2.error.message).toContain("covers canon/config.yaml");
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntest_select_command: "true"\nfloor_scopes:\n  - paths: [tools]\n    command: "true"\n');
    expect(readConfig(root).ok).toBe(true);
  });
});

describe("scoped entries in the queue (D-82)", () => {
  const entries = () => {
    const root = project();
    const db = ws(root, "agent:b").db;
    const me = selfProcess();
    const full1 = enter(db, "/w1", "C-1", "agent:b", me).id;
    const full2 = enter(db, "/w2", "C-2", "agent:b", me).id;
    const scoped3 = enter(db, "/w3", "C-3", "agent:b", me, true).id;
    const scoped4 = enter(db, "/w4", "C-4", "agent:b", me, true).id;
    return { db, full1, full2, scoped3, scoped4 };
  };

  test("BR-2399 BR-2232: within a rank a scoped entry lands before full-floor ones, scoped ones keep their order, and a higher rank still goes first", () => {
    const { full1, scoped3, scoped4 } = entries();
    const p = { urgent: new Set<string>(), scoped: new Set([scoped3, scoped4]) };
    expect(landsBefore({ id: scoped3, subject: "C-3" }, { id: full1, subject: "C-1" }, p)).toBe(true);
    expect(landsBefore({ id: scoped3, subject: "C-3" }, { id: scoped4, subject: "C-4" }, p)).toBe(true);
    expect(landsBefore({ id: scoped4, subject: "C-4" }, { id: scoped3, subject: "C-3" }, p)).toBe(false);
    const urgent = { ...p, urgent: new Set(["C-1"]) };
    expect(landsBefore({ id: full1, subject: "C-1" }, { id: scoped3, subject: "C-3" }, urgent)).toBe(true);
  });

  test("BR-2399: the scoped entry takes the turn ahead of waiting full-floor ones, but not from one already landing", () => {
    const { db, full1, scoped3, scoped4 } = entries();
    const p = { urgent: new Set<string>(), scoped: new Set([scoped3, scoped4]) };
    expect(tryTurn(db, scoped3, 60_000, p).mine).toBe(true);
    db.db.query("UPDATE queue SET state = 'failed' WHERE id = ?").run(scoped3);
    expect(tryTurn(db, full1, 60_000, { urgent: new Set<string>() }).mine).toBe(true); // full1 lands first without the scoped priority
    expect(tryTurn(db, scoped4, 60_000, p).mine).toBe(false); // full1 is landing: not interrupted
  });

  test("BR-2399 BR-2172: a batch leader takes no scoped entry as a member, nor any entry behind one; without scoped entries it takes the full ones", () => {
    const { db, full1, full2, scoped3, scoped4 } = entries();
    const p = { urgent: new Set<string>(), scoped: new Set([scoped3, scoped4]) };
    expect(batchCandidates(db, full1, 10, 60_000, p)).toEqual([]);
    db.db.query("UPDATE queue SET state = 'failed' WHERE id IN (?, ?)").run(scoped3, scoped4);
    expect(batchCandidates(db, full1, 10, 60_000, { urgent: new Set<string>() }).map((c) => c.id)).toEqual([full2]);
  });
});
