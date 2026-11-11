import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import { takeClaim } from "../claims/claims.ts";
import { CoordDb } from "../db.ts";
import { project, sh, ws } from "../testkit.ts";
import { isSecretFile, MAX_FILE_BYTES, snapshotKey, snapshots, takeSnapshot } from "./snapshot.ts";

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

function canon(cwd: string, stdin: string | undefined, ...args: string[]) {
  return canonWith({}, cwd, stdin, ...args);
}

/** Runs canon with extra environment; CLAUDE_CODE_SESSION_ID is cleared unless given, so the test session's own id never leaks in. */
function canonWith(env: Record<string, string>, cwd: string, stdin: string | undefined, ...args: string[]) {
  const base: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:test" };
  delete base["CLAUDE_CODE_SESSION_ID"];
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), env: { ...base, ...env } });
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

  test("BR-2406: an untracked secret file is left out and named, the worktree keeps it, other files go in", () => {
    const root = project();
    writeFileSync(join(root, ".env.local"), "TOKEN=secret\n");
    writeFileSync(join(root, "notes.txt"), "notes\n");
    const s = taken(root);
    expect(s.skipped).toEqual([".env.local"]);
    expect(show(root, `${s.ref}:.env.local`).ok).toBe(false);
    expect(show(root, `${s.ref}:notes.txt`)).toEqual({ ok: true, value: "notes" });
    const message = sh(root, "log", "-1", "--format=%B", s.ref);
    expect(message).toContain("left out, secret files: .env.local");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("TOKEN=secret\n");
  });

  test("BR-2406: the secret list matches on the case-sensitive basename, both sides of each boundary", () => {
    const root = project();
    const out = [".env", "config/.env", ".env.local", "certs/server.pem", "tls.key", "cert.p12", "cert.pfx", "id_ed25519", "id_rsa", "id_ecdsa", "id_rsa.old", "keys.txt"];
    const kept = [".env.schema", ".env.example", ".env.sample", ".env.template", "env.txt", "my.env", "id_ed25519.pub", "id_rsa.old.pub", "keys.md", "monkey.txt"];
    for (const f of [...out, ...kept]) {
      mkdirSync(join(root, dirname(f)), { recursive: true });
      writeFileSync(join(root, f), `${f}\n`);
    }
    const s = taken(root);
    expect(s.skipped).toEqual([...out].sort());
    for (const f of out) expect(show(root, `${s.ref}:${f}`).ok).toBe(false);
    for (const f of kept) expect(show(root, `${s.ref}:${f}`)).toEqual({ ok: true, value: f });
    for (const f of [...out, ...kept]) expect(isSecretFile(f)).toBe(out.includes(f));
    // A separate repository, since on a case-insensitive file system `.ENV` and `.env` are one file
    const upper = project();
    for (const f of [".ENV", "SERVER.PEM", "ID_RSA"]) writeFileSync(join(upper, f), `${f}\n`);
    const u = taken(upper);
    expect(u.skipped).toEqual([]);
    for (const f of [".ENV", "SERVER.PEM", "ID_RSA"]) expect(show(upper, `${u.ref}:${f}`)).toEqual({ ok: true, value: f });
  });

  test("BR-2406: a changed tracked secret file keeps HEAD's version in the snapshot; the worktree keeps the change", () => {
    const root = project();
    writeFileSync(join(root, ".env.production"), "A=1\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "env");
    writeFileSync(join(root, ".env.production"), "A=2\n");
    writeFileSync(join(root, "app.txt"), "changed\n");
    const s = taken(root);
    expect(show(root, `${s.ref}:.env.production`)).toEqual({ ok: true, value: "A=1" });
    expect(show(root, `${s.ref}:app.txt`)).toEqual({ ok: true, value: "changed" });
    expect(sh(root, "log", "-1", "--format=%B", s.ref)).toContain(".env.production");
    expect(readFileSync(join(root, ".env.production"), "utf8")).toBe("A=2\n");
  });

  test("BR-2406: a staged secret file whose worktree copy matches the index is still left out, and the index is unchanged", () => {
    const root = project();
    writeFileSync(join(root, ".env"), "TOKEN=1\n");
    writeFileSync(join(root, "app.txt"), "changed\n");
    sh(root, "add", ".env");
    const before = sh(root, "status", "--porcelain");
    const s = taken(root);
    expect(s.skipped).toEqual([".env"]);
    expect(show(root, `${s.ref}:.env`).ok).toBe(false);
    expect(sh(root, "status", "--porcelain")).toBe(before);
  });

  test("BR-2406: when the only uncommitted change is a secret file no snapshot is made", () => {
    const root = project();
    writeFileSync(join(root, ".env.local"), "TOKEN=1\n");
    expect(takeSnapshot(root)).toEqual({ ok: true, value: { kind: "none", why: "same as the last snapshot" } });
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

  describe("worktrees this session has claimed", () => {
    function claimedSibling(root: string, name: string, actor: string, edit = true) {
      const wt = join(mkdtempSync(join(tmpdir(), "canon-snap-claimed-")), name);
      sh(root, "worktree", "add", "-q", "-b", `change/${name}`, wt);
      if (edit) writeFileSync(join(wt, "app.txt"), `edited in ${name}\n`);
      const c = takeClaim(ws(root, actor).db, name, wt, actor);
      if (!c.ok) throw new Error(c.error.message);
      return wt;
    }
    const hook = (root: string, session: string, agentId?: string) => canon(root, JSON.stringify({ cwd: root, session_id: session, ...(agentId ? { agent_id: agentId } : {}), tool_name: "Bash", tool_input: { command: "cd ../x && git checkout -- ." } }), "snapshot", "take", "--hook");

    test("BR-2182: the main session's call snapshots the worktrees held by agent:<session> only, not a subagent's", () => {
      const root = project();
      claimedSibling(root, "C-11", "agent:abcd1234");
      claimedSibling(root, "C-12", "agent:abcd1234:worker");
      claimedSibling(root, "C-13", "agent:abcd1234", false);
      writeFileSync(join(root, "app.txt"), "primary edit\n");
      const r = hook(root, "abcd1234-0000-4000-8000-000000000000");
      expect([r.code, r.out]).toEqual([0, ""]);
      expect(show(root, `${snapshots(root, "C-11")[0]!.ref}:app.txt`)).toEqual({ ok: true, value: "edited in C-11" });
      expect(snapshots(root, snapshotKey(root))).toHaveLength(1);
      expect(snapshots(root, "C-12")).toHaveLength(0);
      // an unchanged claimed worktree writes nothing
      expect(snapshots(root, "C-13")).toHaveLength(0);
    });

    test("BR-2182: a subagent's call snapshots the worktree held by agent:<session>:<agent_id>, not a sibling's or the main session's", () => {
      const root = project();
      claimedSibling(root, "C-14", "agent:abcd1234:worker");
      claimedSibling(root, "C-15", "agent:abcd1234:other");
      claimedSibling(root, "C-16", "agent:abcd1234");
      const r = hook(root, "abcd1234-0000-4000-8000-000000000000", "worker");
      expect([r.code, r.out]).toEqual([0, ""]);
      expect(snapshots(root, "C-14")).toHaveLength(1);
      expect(snapshots(root, "C-15")).toHaveLength(0);
      expect(snapshots(root, "C-16")).toHaveLength(0);
    });

    test("BR-2182: a changed worktree claimed by another session is not snapshotted", () => {
      const root = project();
      claimedSibling(root, "C-21", "agent:ffff0000");
      claimedSibling(root, "C-22", "agent:abcd1234x"); // a longer session id that merely starts the same
      const r = hook(root, "abcd1234-0000-4000-8000-000000000000");
      expect([r.code, r.out]).toEqual([0, ""]);
      expect(snapshots(root, "C-21")).toHaveLength(0);
      expect(snapshots(root, "C-22")).toHaveLength(0);
    });

    test("BR-2182: when cwd is the claimed worktree itself it is snapshotted once", () => {
      const root = project();
      const wt = claimedSibling(root, "C-31", "agent:abcd1234");
      const r = canon(root, JSON.stringify({ cwd: wt, session_id: "abcd1234-0000", tool_name: "Bash", tool_input: { command: "ls" } }), "snapshot", "take", "--hook");
      expect(r.code).toBe(0);
      expect(snapshots(root, "C-31")).toHaveLength(1);
    });

    test("BR-2182: when the claims cannot be read, the cwd worktree is still snapshotted and the error is reported", () => {
      const root = project();
      writeFileSync(join(root, "app.txt"), "primary edit\n");
      const db = CoordDb.pathFor(root);
      if (!db.ok) throw new Error(db.error.message);
      mkdirSync(dirname(db.value), { recursive: true });
      writeFileSync(db.value, "this is not a database");
      const r = hook(root, "abcd1234-0000-4000-8000-000000000000");
      expect(snapshots(root, snapshotKey(root))).toHaveLength(1);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("cannot read the claims");
    });

    test("BR-2182: without session_id in the hook input the session comes from CLAUDE_CODE_SESSION_ID; with neither only cwd is snapshotted", () => {
      const root = project();
      claimedSibling(root, "C-51", "agent:abcd1234");
      const input = JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "ls" } });
      expect(canonWith({}, root, input, "snapshot", "take", "--hook").code).toBe(0);
      expect(snapshots(root, "C-51")).toHaveLength(0);
      expect(canonWith({ CLAUDE_CODE_SESSION_ID: "abcd1234-0000-4000-8000-000000000000" }, root, input, "snapshot", "take", "--hook").code).toBe(0);
      expect(snapshots(root, "C-51")).toHaveLength(1);
    });

    test("BR-2182: a claimed worktree whose directory is gone is skipped", () => {
      const root = project();
      const gone = claimedSibling(root, "C-61", "agent:abcd1234");
      rmSync(gone, { recursive: true, force: true });
      const r = hook(root, "abcd1234-0000-4000-8000-000000000000");
      expect([r.code, r.out]).toEqual([0, ""]);
      expect(snapshots(root, "C-61")).toHaveLength(0);
    });

    test("BR-2182: without --hook only the current directory's worktree is snapshotted", () => {
      const root = project();
      claimedSibling(root, "C-41", "agent:abcd1234");
      writeFileSync(join(root, "app.txt"), "primary edit\n");
      const r = canon(root, undefined, "snapshot", "take");
      expect(r.code).toBe(0);
      expect(snapshots(root, "C-41")).toHaveLength(0);
    });
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

  test("BR-2184: a snapshot that left out a large file and a secret file names both on its next line and in --json", () => {
    const root = project();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1024 * 1024));
    writeFileSync(join(root, ".env.local"), "TOKEN=1\n");
    writeFileSync(join(root, "a.txt"), "a\n");
    taken(root);
    const lines = canon(root, undefined, "snapshot", "list").out.trimEnd().split("\n");
    expect(lines[1]).toContain("big.bin");
    expect(lines[1]).toContain(".env.local");
    const j = JSON.parse(canon(root, undefined, "snapshot", "list", "--json").out) as { leftOut: string }[];
    expect(j[0]!.leftOut).toContain("big.bin");
    expect(j[0]!.leftOut).toContain(".env.local");
  });

  test("BR-2184: outside a git repository it exits 4", () => {
    expect(canon(mkdtempSync(join(tmpdir(), "canon-snap-list-")), undefined, "snapshot", "list").code).toBe(4);
  });
});
