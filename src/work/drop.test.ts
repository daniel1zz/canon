import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer, claims, questions } from "../coord/state.ts";
import { drop } from "./drop.ts";
import { FAST, project, quiet, sh, startNew, ws } from "./testkit.ts";
import { land } from "./work.ts";

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => JSON.parse(e.detail));
const branches = (root: string) => sh(root, "branch", "--list", "change/*");

function withCommit(root: string, title: string) {
  const s = startNew(root, title);
  writeFileSync(join(s.worktree, "wip.txt"), "wip\n");
  sh(s.worktree, "add", "wip.txt");
  sh(s.worktree, "commit", "-qm", "wip");
  return s;
}

describe("dropping a change", () => {
  test("BR-2064: a fully landed change is dropped at once: worktree, branch, claim and handoff go", async () => {
    const root = project();
    const s = startNew(root, "Landed");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const r = drop(ws(root, "agent:a"), s.change, quiet);
    expect(r.ok && r.value.kind).toBe("dropped");
    expect(existsSync(s.worktree)).toBe(false);
    expect(branches(root)).toBe("");
    expect(claims(ws(root).db)).toEqual([]);
    expect(events(root, "drop.done").length).toBe(1);
  });

  test("BR-2064: a branch without a worktree is dropped when all its commits are on main; inside the worktree or with nothing there it is refused", async () => {
    const root = project();
    const s = startNew(root, "Branch only");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const inside = drop(ws(s.worktree), s.change, quiet);
    expect(!inside.ok && inside.error.code).toBe("invalid");
    sh(root, "worktree", "remove", s.worktree);
    const r = drop(ws(root), s.change, quiet);
    expect(r.ok && r.value).toMatchObject({ kind: "dropped", worktree: null });
    expect(branches(root)).toBe("");
    const none = drop(ws(root), "C-99", quiet);
    expect(!none.ok && none.error.code).toBe("not_found");
  });

  test("BR-2064 BR-2065: an ignored file a build cannot regenerate counts as work; ignored node_modules does not", async () => {
    const root = project();
    writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "ignore");
    const deps = startNew(root, "Deps only");
    expect((await land(ws(deps.worktree), FAST, quiet)).kind).toBe("landed");
    mkdirSync(join(deps.worktree, "node_modules"), { recursive: true });
    writeFileSync(join(deps.worktree, "node_modules/i.js"), "1\n");
    expect(drop(ws(root), deps.change, quiet)).toMatchObject({ ok: true, value: { kind: "dropped" } });
    const secret = startNew(root, "Has env");
    expect((await land(ws(secret.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(join(secret.worktree, ".env"), "TOKEN=1\n");
    const r = drop(ws(root), secret.change, quiet);
    expect(r.ok && r.value.kind === "asked" && r.value.losses).toEqual(["ignored: .env"]);
    expect(existsSync(join(secret.worktree, ".env"))).toBe(true);
  });

  test("BR-2064: a worktree another process is in is not dropped: exit 5 naming the pid, nothing deleted", async () => {
    const root = project();
    const s = startNew(root, "Busy");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const proc = Bun.spawn(["sleep", "30"], { cwd: s.worktree });
    try {
      const r = drop(ws(root), s.change, quiet);
      expect(!r.ok && r.error.code).toBe("conflict");
      expect(!r.ok && r.error.message).toContain(`pid ${proc.pid} (sleep)`);
      expect(existsSync(s.worktree)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("BR-2065: work that would be lost is listed in a question for a human and nothing is deleted; asking again does not repeat it", () => {
    const root = project();
    const s = withCommit(root, "Unlanded");
    writeFileSync(join(s.worktree, "notes.txt"), "n\n");
    const r = drop(ws(root), s.change, quiet);
    expect(r.ok && r.value.kind).toBe("asked");
    expect(existsSync(s.worktree)).toBe(true);
    expect(branches(root)).toContain(s.branch);
    const q = questions(ws(root).db, "pending");
    expect(q.length).toBe(1);
    expect(q[0]!.question).toMatch(/commit not on main: [0-9a-f]+ wip/);
    expect(q[0]!.question).toContain("uncommitted: ?? notes.txt");
    expect(q[0]!.options).toEqual(["yes", "no"]);
    const again = drop(ws(root), s.change, quiet);
    expect(again.ok && again.value.kind).toBe("waiting");
    expect(questions(ws(root).db, "all").length).toBe(1);
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["waiting"]);
  });

  test("BR-2066: a human yes, or an agent relaying it, drops an unchanged state; a no, or a bare agent yes, does not", () => {
    const root = project();
    const yes = withCommit(root, "Approved");
    const asked = drop(ws(root), yes.change, quiet);
    if (!asked.ok || asked.value.kind !== "asked") throw new Error("expected a question");
    answer(ws(root).db, asked.value.question, "Yes", "human:dz");
    const done = drop(ws(root), yes.change, quiet);
    expect(done.ok && done.value.kind).toBe("dropped");
    expect(existsSync(yes.worktree)).toBe(false);
    expect(events(root, "drop.done")[0].losses[0]).toContain("wip");

    const no = withCommit(root, "Declined");
    const q2 = drop(ws(root), no.change, quiet);
    if (!q2.ok || q2.value.kind !== "asked") throw new Error("expected a question");
    answer(ws(root).db, q2.value.question, "no", "human:dz");
    expect(drop(ws(root), no.change, quiet)).toMatchObject({ ok: true, value: { kind: "declined" } });
    expect(existsSync(no.worktree)).toBe(true);

    const byAgent = withCommit(root, "Agent said yes");
    const q3 = drop(ws(root), byAgent.change, quiet);
    if (!q3.ok || q3.value.kind !== "asked") throw new Error("expected a question");
    // an agent's bare answer (no relay) that reached the table some other way does not approve
    ws(root).db.db.query("UPDATE questions SET answer = 'yes', answered_by = 'agent:x' WHERE id = ?").run(q3.value.question);
    expect(drop(ws(root), byAgent.change, quiet)).toMatchObject({ ok: true, value: { kind: "declined" } });
    expect(existsSync(byAgent.worktree)).toBe(true);

    const relayed = withCommit(root, "Relayed yes");
    const q4 = drop(ws(root), relayed.change, quiet);
    if (!q4.ok || q4.value.kind !== "asked") throw new Error("expected a question");
    expect(answer(ws(root).db, q4.value.question, "yes", "agent:x", "删吧").ok).toBe(true);
    expect(drop(ws(root), relayed.change, quiet)).toMatchObject({ ok: true, value: { kind: "dropped" } });
  });

  test("BR-2066: when more would be lost after the question, a new question is asked", () => {
    const root = project();
    const s = withCommit(root, "Moving");
    const first = drop(ws(root), s.change, quiet);
    if (!first.ok || first.value.kind !== "asked") throw new Error("expected a question");
    answer(ws(root).db, first.value.question, "yes", "human:dz");
    writeFileSync(join(s.worktree, "more.txt"), "more\n");
    sh(s.worktree, "add", "more.txt");
    sh(s.worktree, "commit", "-qm", "more");
    const again = drop(ws(root), s.change, quiet);
    expect(again.ok && again.value.kind).toBe("asked");
    expect(existsSync(s.worktree)).toBe(true);
    expect(questions(ws(root).db, "all").length).toBe(2);
  });
});
