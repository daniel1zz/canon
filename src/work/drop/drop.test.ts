import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processOf } from "../claims/liveness.ts";
import { claims } from "../claims/claims.ts";
import { drop } from "./drop.ts";
import { writeSchemaFile } from "../../config/reference/reference.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { stop } from "../session/session.ts";
import { handoffs } from "../session/handoffs.ts";

/** The holder frees its claim first: a live claim refuses every drop, the same actor included (BR-2064). */
function released<T extends { worktree: string }>(s: T): T {
  const r = stop(ws(s.worktree), "drop it", undefined, true);
  if (!r.ok) throw new Error(r.error.message);
  return s;
}
import { land } from "../land/land.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

/** The canon CLI as `actor`, outside Claude Code. */
function canon(cwd: string, actor: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor };
  delete env["CLAUDECODE"]; // reason: inside Claude Code a human: CANON_ACTOR is refused (BR-2023)
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((e) => JSON.parse(e.detail));
const branches = (root: string) => sh(root, "branch", "--list", "change/*");
const archives = (root: string) => sh(root, "for-each-ref", "--format=%(refname)", "refs/canon/archive");

function withCommit(root: string, title: string, actor = "agent:a") {
  const s = startNew(root, title, actor);
  writeFileSync(join(s.worktree, "wip.txt"), "wip\n");
  sh(s.worktree, "add", "wip.txt");
  sh(s.worktree, "commit", "-qm", "wip");
  return s;
}

function ignoring(root: string) {
  writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "ignore");
}

describe("dropping a change", () => {
  test("BR-2064: a fully landed change is dropped at once without an archive: worktree, branch, claim and handoff go", async () => {
    const root = project();
    const s = released(startNew(root, "Landed"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const r = drop(ws(root, "agent:a"), s.change, quiet);
    expect(r.ok && r.value.archive).toBe(null);
    expect(existsSync(s.worktree)).toBe(false);
    expect(branches(root)).toBe("");
    expect(archives(root)).toBe("");
    expect(handoffs(ws(root).db).filter((h) => h.subject === s.change)).toEqual([]);
    expect(claims(ws(root).db)).toEqual([]);
    expect(events(root, "drop.done").length).toBe(1);
  });

  test("BR-2064: a branch without a worktree is dropped when all its commits are on main; inside the worktree or with nothing there it is refused", async () => {
    const root = project();
    const s = released(startNew(root, "Branch only"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const inside = drop(ws(s.worktree), s.change, quiet);
    expect(!inside.ok && inside.error.code).toBe("invalid");
    sh(root, "worktree", "remove", s.worktree);
    const r = drop(ws(root), s.change, quiet);
    expect(r.ok && r.value).toMatchObject({ worktree: null, archive: null });
    expect(branches(root)).toBe("");
    const none = drop(ws(root), "C-99", quiet);
    expect(!none.ok && none.error.code).toBe("not_found");
  });

  test("BR-2064: ignored node_modules is not work; an ignored .env is, and goes into the archive", async () => {
    const root = project();
    ignoring(root);
    const deps = released(startNew(root, "Deps only"));
    expect((await land(ws(deps.worktree), FAST, quiet)).kind).toBe("landed");
    mkdirSync(join(deps.worktree, "node_modules"), { recursive: true });
    writeFileSync(join(deps.worktree, "node_modules/i.js"), "1\n");
    expect(drop(ws(root), deps.change, quiet)).toMatchObject({ ok: true, value: { archive: null } });
    const secret = released(startNew(root, "Has env"));
    expect((await land(ws(secret.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(join(secret.worktree, ".env"), "TOKEN=1\n");
    const r = drop(ws(root), secret.change, quiet);
    if (!r.ok || !r.value.archive) throw new Error("expected an archive");
    expect(r.value.losses).toEqual(["ignored: .env"]);
    expect(sh(root, "show", `${r.value.archive}:.env`)).toBe("TOKEN=1");
  });

  test("BR-2179: a landed change whose only ignored file is canon's .canon is dropped without an archive, whatever regenerable says", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nregenerable: [node_modules]\n");
    sh(root, "commit", "-qam", "regenerable");
    const s = released(startNew(root, "Schema only"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const w = writeSchemaFile(s.worktree);
    if (!w.ok) throw new Error(w.error.message);
    expect(drop(ws(root), s.change, quiet)).toMatchObject({ ok: true, value: { archive: null } });
    expect(existsSync(s.worktree)).toBe(false);
  });

  test("BR-2064: a change another operator holds a live claim on is not dropped and not archived: exit 5", () => {
    const root = project();
    const s = withCommit(root, "Theirs", "agent:b");
    const r = drop(ws(root, "agent:a"), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(existsSync(s.worktree)).toBe(true);
    expect(archives(root)).toBe("");
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["claimed"]);
  });

  test("BR-2064 BR-2100: another operator's claim whose session process is gone does not stop the drop", async () => {
    const root = project();
    const s = withCommit(root, "Theirs, gone", "agent:b");
    const sleeper = Bun.spawn(["sleep", "30"]);
    const dead = processOf(sleeper.pid)!;
    sleeper.kill("SIGKILL");
    await sleeper.exited;
    ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(dead.pid, dead.start, s.change);
    const r = drop(ws(root, "agent:a"), s.change, quiet);
    expect(r.ok).toBe(true);
    expect(existsSync(s.worktree)).toBe(false);
  });

  test("BR-2064: a worktree another process is in is not dropped or archived, landed or not: exit 5 naming the pid", async () => {
    const root = project();
    const s = released(startNew(root, "Busy"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const unlanded = released(withCommit(root, "Busy and unlanded"));
    for (const t of [s, unlanded]) {
      const proc = Bun.spawn(["sleep", "30"], { cwd: t.worktree });
      try {
        const r = drop(ws(root), t.change, quiet);
        expect(!r.ok && r.error.code).toBe("conflict");
        expect(!r.ok && r.error.message).toContain(`pid ${proc.pid} (sleep)`);
        expect(existsSync(t.worktree)).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }
    expect(archives(root)).toBe("");
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["in-use", "in-use"]);
  });

  test.skipIf(process.platform === "linux")("BR-2064: while drop runs the change is held: a start arriving meanwhile is refused with exit 5", async () => {
    const root = project();
    const s = released(startNew(root, "Racing"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed"); // the change is open on main
    writeFileSync(join(s.worktree, "wip.txt"), "wip\n");
    sh(s.worktree, "add", "wip.txt");
    sh(s.worktree, "commit", "-qm", "wip");
    ws(root).db.db.query("DELETE FROM claims").run(); // the first session stopped with --release
    // A stand-in for lsof: while drop waits for it, another session tries to start the change.
    const bin = mkdtempSync(join(tmpdir(), "canon-racelsof-"));
    const out = join(bin, "start-exit");
    const main = join(import.meta.dir, "..", "..", "cli", "main.ts");
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\ncd ${JSON.stringify(root)} && CANON_ACTOR=agent:b bun ${JSON.stringify(main)} work start ${s.change} >/dev/null 2>&1; echo $? > ${JSON.stringify(out)}\nexit 0\n`, { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    try {
      const r = drop(ws(root), s.change, quiet);
      expect(r.ok && r.value.archive).toBeTruthy();
    } finally {
      process.env["PATH"] = path;
    }
    expect(readFileSync(out, "utf8").trim()).toBe("5");
    expect(claims(ws(root).db)).toEqual([]);
    expect(existsSync(s.worktree)).toBe(false);
  });

  test.skipIf(process.platform === "linux")("BR-2064 BR-2026: when processes cannot be listed nothing is deleted, the error is an environment failure, and a drop.refuse is written", async () => {
    const root = project();
    const s = released(startNew(root, "No lsof"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const bin = mkdtempSync(join(tmpdir(), "canon-nolsof-"));
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    try {
      const r = drop(ws(root), s.change, quiet);
      expect(!r.ok && r.error.code).toBe("io");
      expect(!r.ok && r.error.message).toContain("nothing was deleted");
      expect(existsSync(s.worktree)).toBe(true);
    } finally {
      process.env["PATH"] = path;
    }
    expect(branches(root)).toContain(s.branch);
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["no-process-list"]);
  });

  test("BR-2102: an unlanded commit is archived at the branch tip, then deleted without asking; the printed commands restore the branch", () => {
    const root = project();
    const s = released(withCommit(root, "Unlanded"));
    const tip = sh(s.worktree, "rev-parse", "HEAD");
    const lines: string[] = [];
    const r = drop(ws(root), s.change, (l) => lines.push(l));
    if (!r.ok || !r.value.archive) throw new Error("expected an archive");
    expect(r.value.archive).toMatch(new RegExp(`^refs/canon/archive/${s.change}/\\d{4}-\\d{2}-\\d{2}T`));
    expect(sh(root, "rev-parse", r.value.archive)).toBe(tip);
    expect(r.value.losses[0]).toMatch(/^commit not on main: [0-9a-f]+ wip$/);
    expect(existsSync(s.worktree)).toBe(false);
    expect(branches(root)).toBe("");
    expect(events(root, "drop.done")[0]).toMatchObject({ archive: r.value.archive });
    expect(lines.join("\n")).toContain(r.value.restore[0]!);
    for (const c of r.value.restore) expect(Bun.spawnSync(["sh", "-c", c], { cwd: root }).exitCode).toBe(0);
    expect(readFileSync(join(s.worktree, "wip.txt"), "utf8")).toBe("wip\n");
  });

  test("BR-2102: modified, untracked and ignored files are archived with their current content and listed in drop.done; node_modules is not; the restore brings them back", () => {
    const root = project();
    ignoring(root);
    const s = released(startNew(root, "Dirty"));
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    writeFileSync(join(s.worktree, "notes.txt"), "n\n");
    writeFileSync(join(s.worktree, ".env"), "TOKEN=2\n");
    mkdirSync(join(s.worktree, "node_modules"), { recursive: true });
    writeFileSync(join(s.worktree, "node_modules/i.js"), "1\n");
    sh(s.worktree, "add", "app.txt");
    const r = drop(ws(root), s.change, quiet);
    if (!r.ok || !r.value.archive) throw new Error("expected an archive");
    expect(r.value.losses.slice(1)).toEqual(["uncommitted: M  app.txt", "uncommitted: ?? notes.txt", "ignored: .env"]);
    const files = sh(root, "ls-tree", "-r", "--name-only", r.value.archive).split("\n");
    expect(files).toEqual(expect.arrayContaining(["app.txt", "notes.txt", ".env"]));
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(events(root, "drop.done")[0]).toMatchObject({ archive: r.value.archive, losses: r.value.losses });
    expect(existsSync(s.worktree)).toBe(false);
    for (const c of r.value.restore) expect(Bun.spawnSync(["sh", "-c", c], { cwd: root }).exitCode).toBe(0);
    expect(readFileSync(join(s.worktree, "app.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(s.worktree, "notes.txt"), "utf8")).toBe("n\n");
    expect(readFileSync(join(s.worktree, ".env"), "utf8")).toBe("TOKEN=2\n");
  });

  test("BR-2103: a file that appears after the archive was written is not deleted: exit 4, the hold is released", () => {
    const root = project();
    const s = released(withCommit(root, "Late file"));
    // git runs reference-transaction when the archive ref is created: the moment to add work behind drop's back.
    const hook = join(root, ".git", "hooks", "reference-transaction");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\n[ "$1" = committed ] && grep -q refs/canon/archive && echo late > ${JSON.stringify(join(s.worktree, "late.txt"))}\nexit 0\n`, { mode: 0o755 });
    const r = drop(ws(root), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    expect(!r.ok && r.error.message).toContain("nothing was deleted");
    expect(readFileSync(join(s.worktree, "late.txt"), "utf8")).toBe("late\n");
    expect(branches(root)).toContain(s.branch);
    expect(claims(ws(root).db)).toEqual([]); // the hold is gone; the claim was released before the drop, so none comes back
  });

  test("BR-2103: when the archive ref cannot be written nothing is deleted: exit 4, a drop.refuse with reason archive", () => {
    const root = project();
    const s = released(withCommit(root, "Blocked"));
    // A ref named exactly refs/canon/archive/<C-n> makes every refs/canon/archive/<C-n>/<time> impossible.
    sh(root, "update-ref", `refs/canon/archive/${s.change}`, "HEAD");
    const r = drop(ws(root), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    expect(!r.ok && r.error.message).toContain("nothing was deleted");
    expect(existsSync(join(s.worktree, "wip.txt"))).toBe(true);
    expect(branches(root)).toContain(s.branch);
    expect(claims(ws(root).db)).toEqual([]); // the hold is gone; nothing was claimed before the drop
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["archive"]);
    expect(events(root, "drop.done")).toEqual([]);
  });

  test("BR-2064: the holder's own live claim stops its drop too: exit 5 with the stop --release hint, the claim stays as it was", () => {
    const root = project();
    const s = withCommit(root, "Mine", "agent:a");
    const before = claims(ws(root).db);
    const r = drop(ws(root, "agent:a"), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toContain("canon work stop --release");
    expect(claims(ws(root).db)).toEqual(before);
    expect(existsSync(join(s.worktree, "wip.txt"))).toBe(true);
    expect(archives(root)).toBe("");
  });

  test("BR-2064: a drop that fails after taking over a claim whose process is gone puts that claim back as it was", async () => {
    const root = project();
    const s = withCommit(root, "Theirs, gone, busy", "agent:b");
    const sleeper = Bun.spawn(["sleep", "30"]);
    const dead = processOf(sleeper.pid)!;
    sleeper.kill("SIGKILL");
    await sleeper.exited;
    ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(dead.pid, dead.start, s.change);
    const row = () => ws(root).db.db.query("SELECT subject, holder, worktree, expires_at, pid, pid_start FROM claims").all();
    const before = row();
    const busy = Bun.spawn(["sleep", "30"], { cwd: s.worktree });
    try {
      const r = drop(ws(root, "agent:a"), s.change, quiet);
      expect(!r.ok && r.error.code).toBe("conflict");
    } finally {
      busy.kill();
      await busy.exited;
    }
    expect(row()).toEqual(before);
  });

  test("BR-2064 BR-2102: a worktree git cannot remove (locked) leaves everything in place: branch put back, exit 4, the archive ref named, a drop.refuse", () => {
    const root = project();
    const s = released(withCommit(root, "Locked"));
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    sh(s.worktree, "add", "app.txt");
    writeFileSync(join(s.worktree, "notes.txt"), "n\n");
    const tip = sh(s.worktree, "rev-parse", "HEAD");
    const index = sh(s.worktree, "ls-files", "-s");
    sh(root, "worktree", "lock", s.worktree);
    const r = drop(ws(root), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    const ref = archives(root);
    expect(ref).toMatch(new RegExp(`^refs/canon/archive/${s.change}/`));
    expect(!r.ok && r.error.message).toContain("nothing was deleted");
    expect(!r.ok && r.error.message).toContain(ref);
    // All or nothing (issue #58): the branch is back at its tip and the worktree still has it checked out.
    expect(sh(root, "rev-parse", `refs/heads/${s.branch}`)).toBe(tip);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(tip);
    // The worktree's own index and files were not touched (BR-2102).
    expect(sh(s.worktree, "ls-files", "-s")).toBe(index);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("M  app.txt\n?? notes.txt");
    expect(readFileSync(join(s.worktree, "notes.txt"), "utf8")).toBe("n\n");
    expect(events(root, "drop.refuse")).toMatchObject([{ reason: "remove", archive: ref, branch_restored: true }]);
    expect(events(root, "drop.done")).toEqual([]);
    expect(claims(ws(root).db)).toEqual([]);
  });

  test("BR-2103 BR-2026: a branch that cannot be deleted as read (it moved) deletes nothing: exit 4, a drop.refuse with reason archive", () => {
    const root = project();
    const s = released(withCommit(root, "Moved"));
    // Aborting the deletion's ref transaction is what git does when the branch no longer has the tip drop read.
    const hook = join(root, ".git", "hooks", "reference-transaction");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\n[ "$1" = prepared ] && grep -q "refs/heads/${s.branch}" && exit 1\nexit 0\n`, { mode: 0o755 });
    const r = drop(ws(root), s.change, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    expect(!r.ok && r.error.message).toContain("nothing was deleted");
    expect(branches(root)).toContain(s.branch);
    expect(existsSync(join(s.worktree, "wip.txt"))).toBe(true);
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["archive"]);
    expect(events(root, "drop.done")).toEqual([]);
  });

  test("BR-2064: through the CLI a lower-case id is dropped as its upper-case change, and a change still open on main gets the canon change drop hint", async () => {
    const root = project();
    const s = released(startNew(root, "Open on main"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed"); // without --finish: still open on main
    const r = canon(root, "agent:a", "work", "drop", s.change.toLowerCase());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`dropped ${s.change}`);
    expect(r.out).toContain(`${s.change} is still open on main; mark it with \`canon change drop ${s.change}\``);
    expect(existsSync(s.worktree)).toBe(false);
  });

  test("BR-2064: a change worktree that has main checked out is refused with exit 2; main is never deleted", () => {
    const root = project();
    const dir = `${root}.worktrees`;
    mkdirSync(dir, { recursive: true });
    sh(root, "worktree", "add", "-q", "-f", join(dir, "C-7"), "main");
    const r = canon(root, "agent:a", "work", "drop", "C-7");
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to delete main");
    expect(sh(root, "rev-parse", "--verify", "refs/heads/main")).not.toBe("");
    expect(existsSync(join(dir, "C-7"))).toBe(true);
  });

  test("BR-2064: through the CLI a drop arriving while the same human's clean removes the change is refused with exit 5", async () => {
    const root = project();
    const s = released(startNew(root, "Cleaned"));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    // clean deletes the branch while it still holds the change: the moment another terminal runs drop.
    const out = join(mkdtempSync(join(tmpdir(), "canon-cleandrop-")), "drop-exit");
    const hook = join(root, ".git", "hooks", "reference-transaction");
    mkdirSync(join(hook, ".."), { recursive: true });
    const env = `CANON_ACTOR=human:x CLAUDECODE=`;
    writeFileSync(hook, `#!/bin/sh\n[ "$1" = prepared ] && [ ! -e ${JSON.stringify(out)} ] && grep -q "refs/heads/${s.branch}" && { cd ${JSON.stringify(root)} && ${env} bun ${JSON.stringify(MAIN)} work drop ${s.change} >/dev/null 2>&1; echo $? > ${JSON.stringify(out)}; }\nexit 0\n`, { mode: 0o755 });
    const c = canon(root, "human:x", "work", "clean", s.change);
    expect(c.code).toBe(0);
    expect(readFileSync(out, "utf8").trim()).toBe("5");
    expect(existsSync(s.worktree)).toBe(false);
    expect(events(root, "drop.refuse").map((e) => e.reason)).toEqual(["claimed"]);
  });
});
