import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import { project, sh } from "../testkit.ts";
import { MAX_FILE_BYTES, snapshotKey, snapshots, takeSnapshot } from "./snapshot.ts";

// reason: these tests spawn the canon CLI and run real git commands, which is what they test.
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");

function canon(cwd: string, stdin: string | undefined, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function taken(cwd: string, now?: Date) {
  const r = takeSnapshot(cwd, now);
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "taken") throw new Error(`expected a snapshot, got: ${r.value.why}`);
  return r.value;
}

const show = (root: string, spec: string) => git(root, "show", spec);
const DAY = 86_400_000;

describe("taking a snapshot", () => {
  test("BR-2182: tracked changes and untracked files go in, ignored files do not, and the worktree and its index are left as they were", () => {
    const root = project();
    writeFileSync(join(root, ".gitignore"), ".env\n");
    sh(root, "add", ".gitignore");
    sh(root, "commit", "-qm", "ignore");
    writeFileSync(join(root, "app.txt"), "changed\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    writeFileSync(join(root, ".env"), "TOKEN=1\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    sh(root, "add", "staged.txt");
    const before = sh(root, "status", "--porcelain");
    const s = taken(root);
    expect(sh(root, "status", "--porcelain")).toBe(before);
    expect(show(root, `${s.ref}:app.txt`)).toEqual({ ok: true, value: "changed" });
    expect(show(root, `${s.ref}:new.txt`)).toEqual({ ok: true, value: "new" });
    expect(show(root, `${s.ref}:staged.txt`)).toEqual({ ok: true, value: "staged" });
    expect(show(root, `${s.ref}:.env`).ok).toBe(false);
    expect(sh(root, "rev-parse", `${s.ref}^`)).toBe(sh(root, "rev-parse", "HEAD"));
  });

  test("BR-2182: a snapshot leaves the index file byte for byte as it was, even when its stat data is out of date", () => {
    const root = project();
    // reason: a newer mtime with the same content makes git status want to refresh and write the index (#83)
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "app.txt"), later, later);
    writeFileSync(join(root, "new.txt"), "new\n");
    const index = join(root, ".git", "index");
    const before = readFileSync(index);
    taken(root);
    expect(readFileSync(index).equals(before)).toBe(true);
  });

  test("BR-2182: what git checkout <file> throws away is still in the snapshot taken before it", () => {
    const root = project();
    writeFileSync(join(root, "app.txt"), "uncommitted work\n");
    const s = taken(root);
    sh(root, "checkout", "-q", "app.txt");
    expect(show(root, `${s.ref}:app.txt`)).toEqual({ ok: true, value: "uncommitted work" });
  });

  test("BR-2182: nothing uncommitted, or nothing new since the last snapshot, makes no snapshot", () => {
    const root = project();
    expect(canon(root, undefined, "snapshot", "take").out.trim()).toBe("no snapshot: nothing uncommitted");
    writeFileSync(join(root, "app.txt"), "x\n");
    taken(root);
    expect(canon(root, undefined, "snapshot", "take").out.trim()).toBe("no snapshot: same as the last snapshot");
    expect(snapshots(root, snapshotKey(root))).toHaveLength(1);
  });

  test("BR-2182: a deleted tracked file is absent from the snapshot", () => {
    const root = project();
    writeFileSync(join(root, "b.txt"), "b\n");
    sh(root, "add", "b.txt");
    sh(root, "commit", "-qm", "b");
    unlinkSync(join(root, "b.txt"));
    const s = taken(root);
    expect(show(root, `${s.ref}:b.txt`).ok).toBe(false);
    expect(show(root, `${s.ref}:app.txt`).ok).toBe(true);
  });

  test("BR-2182: a file over the size limit is left out and named; smaller ones go in", () => {
    const root = project();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1024 * 1024));
    writeFileSync(join(root, "small.txt"), "small\n");
    const s = taken(root);
    expect(s.skipped).toEqual(["big.bin"]);
    expect(show(root, `${s.ref}:big.bin`).ok).toBe(false);
    expect(show(root, `${s.ref}:small.txt`)).toEqual({ ok: true, value: "small" });
    const message = sh(root, "log", "-1", "--format=%B", s.ref);
    expect(message).toContain("left out");
    expect(message).toContain("big.bin");
  });

  test("BR-2182: --hook snapshots the worktree named by the hook input's cwd and prints nothing", () => {
    const root = project();
    const other = join(mkdtempSync(join(tmpdir(), "canon-snap-wt-")), "C-9");
    sh(root, "worktree", "add", "-q", "-b", "change/C-9", other);
    writeFileSync(join(other, "app.txt"), "in the other worktree\n");
    const r = canon(root, JSON.stringify({ cwd: other, tool_name: "Bash", tool_input: { command: "ls" } }), "snapshot", "take", "--hook");
    expect([r.code, r.out]).toEqual([0, ""]);
    const all = snapshots(root, "C-9");
    expect(all).toHaveLength(1);
    expect(show(root, `${all[0]!.ref}:app.txt`)).toEqual({ ok: true, value: "in the other worktree" });
    expect(snapshots(root, snapshotKey(root))).toHaveLength(0);
  });

  test("BR-2182: outside a git repository, or in one that is not a canon project, nothing is snapshotted and the exit code is 0", () => {
    const outside = mkdtempSync(join(tmpdir(), "canon-snap-none-"));
    expect(canon(outside, undefined, "snapshot", "take")).toMatchObject({ code: 0, out: "no snapshot: not a git worktree\n" });
    sh(outside, "init", "-q");
    writeFileSync(join(outside, "x.txt"), "x\n");
    expect(canon(outside, undefined, "snapshot", "take")).toMatchObject({ code: 0, out: "no snapshot: not a canon project\n" });
  });
});

describe("keeping snapshots", () => {
  test("BR-2183: every snapshot of the last 24 hours stays, however many there are", () => {
    const root = project();
    const start = Date.now() - 3_600_000;
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(root, "app.txt"), `version ${i}\n`);
      taken(root, new Date(start + i * 60_000));
    }
    expect(snapshots(root, snapshotKey(root))).toHaveLength(25);
  });

  test("BR-2183: past 24 hours only the newest snapshot of each hour stays", () => {
    const root = project();
    const now = Date.now();
    const hourStart = Math.floor((now - 2 * DAY) / 3_600_000) * 3_600_000;
    const at = [hourStart + 60_000, hourStart + 120_000, hourStart + 180_000, hourStart + 3_600_000 + 60_000];
    at.forEach((t, i) => {
      writeFileSync(join(root, "app.txt"), `old ${i}\n`);
      taken(root, new Date(t));
    });
    writeFileSync(join(root, "app.txt"), "now\n");
    taken(root, new Date(now));
    const kept = snapshots(root, snapshotKey(root)).map((s) => show(root, `${s.ref}:app.txt`));
    expect(kept).toEqual([{ ok: true, value: "now" }, { ok: true, value: "old 3" }, { ok: true, value: "old 2" }]);
  });

  test("BR-2183: snapshots older than 14 days go, in any worktree; younger ones and those of cleaned-up worktrees stay", () => {
    const root = project();
    const now = Date.now();
    for (const [name, days] of [["C-1", 15], ["C-2", 13]] as const) {
      const wt = join(mkdtempSync(join(tmpdir(), "canon-snap-age-")), name);
      sh(root, "worktree", "add", "-q", "-b", `change/${name}`, wt);
      writeFileSync(join(wt, "app.txt"), `${name}\n`);
      taken(wt, new Date(now - days * DAY));
      sh(root, "worktree", "remove", "--force", wt);
    }
    expect(snapshots(root, "C-1")).toHaveLength(1);
    writeFileSync(join(root, "app.txt"), "today\n");
    taken(root, new Date(now));
    expect(snapshots(root, "C-1")).toHaveLength(0);
    expect(snapshots(root, "C-2")).toHaveLength(1);
  });
});

describe("deleting old snapshots fails", () => {
  test("BR-2183: a snapshot is kept and reported as taken when deleting old ones fails; --hook says so in a systemMessage and exits 0, without it exit 4", () => {
    const root = project();
    const key = snapshotKey(root);
    const hourStart = Math.floor((Date.now() - 2 * DAY) / 3_600_000) * 3_600_000;
    writeFileSync(join(root, "app.txt"), "old 1\n");
    taken(root, new Date(hourStart + 60_000));
    writeFileSync(join(root, "app.txt"), "old 2\n");
    taken(root, new Date(hourStart + 120_000));
    // the older of the two in that hour is the one the next snapshot deletes; lock its ref so the delete fails
    const doomed = snapshots(root, key).at(-1)!.ref;
    const lock = join(root, ".git", `${doomed}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    for (const [hook, text, code] of [[true, "now 1\n", 0], [false, "now 2\n", 4]] as const) {
      writeFileSync(join(root, "app.txt"), text);
      const r = hook ? canon(root, JSON.stringify({ cwd: root }), "snapshot", "take", "--hook") : canon(root, undefined, "snapshot", "take");
      expect(r.code).toBe(code);
      const said = hook ? (JSON.parse(r.out) as { systemMessage: string }).systemMessage : r.err;
      expect(said).toContain("taken, but deleting old snapshots failed");
      expect(show(root, `${snapshots(root, key)[0]!.ref}:app.txt`)).toEqual({ ok: true, value: text.trim() });
    }
    expect(snapshots(root, key).map((s) => s.ref)).toContain(doomed);
  });
});

describe("listing snapshots", () => {
  test("BR-2184: newest first, with the files each holds and how to get a file back; --json gives the same", () => {
    const root = project();
    expect(canon(root, undefined, "snapshot", "list")).toMatchObject({ code: 0, out: `no snapshots of ${sh(root, "rev-parse", "--show-toplevel")}\n` });
    writeFileSync(join(root, "a.txt"), "a\n");
    taken(root, new Date(Date.now() - 1000));
    writeFileSync(join(root, "b.txt"), "b\n");
    taken(root);
    const r = canon(root, undefined, "snapshot", "list");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toContain("2 file(s): a.txt, b.txt");
    expect(lines[1]).toContain("1 file(s): a.txt");
    expect(lines.at(-1)).toContain("git show <ref>:<path>");
    const j = JSON.parse(canon(root, undefined, "snapshot", "list", "--json").out) as { files: string[] }[];
    expect(j.map((s) => s.files)).toEqual([["a.txt", "b.txt"], ["a.txt"]]);
  });

  test("BR-2184: outside a git repository it exits 4", () => {
    expect(canon(mkdtempSync(join(tmpdir(), "canon-snap-list-")), undefined, "snapshot", "list").code).toBe(4);
  });
});
