import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claims, takeClaim } from "../claims/claims.ts";
import { clean, start, stop } from "./session.ts";
import { writeSchemaFile } from "../../config/reference/reference.ts";
import { land } from "../land/land.ts";
import { git } from "../../kernel/git.ts";

import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

describe("work start", () => {
  test("BR-2012: a new change gets its own worktree, branch, committed change file and claim", () => {
    const root = project();
    const s = startNew(root, "Refund window");
    expect(s.change).toBe("C-1");
    expect(existsSync(join(s.worktree, "canon/changes/C-1-refund-window.md"))).toBe(true);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(claims(ws(root).db).map((c) => [c.subject, c.holder])).toEqual([["C-1", s.worktree]]);
  });

  test("BR-2038: an open change on main is started even when the primary checkout has another branch out", async () => {
    const root = project();
    const s = startNew(root, "Planned");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    sh(root, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "app.txt"), "diverged\n");
    sh(root, "rm", "-rq", "canon/changes");
    sh(root, "commit", "-qam", "elsewhere: no changes dir");
    stop(ws(s.worktree), "hand over", undefined, true); // agent:a releases, so agent:b may take it (BR-2011)
    sh(root, "worktree", "remove", s.worktree);
    const again = start(ws(root, "agent:b"), { change: s.change }, quiet);
    expect(again.ok).toBe(true);
    if (again.ok) expect(readFileSync(join(again.value.worktree, "app.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("BR-2011: a change claimed by another worktree is refused while its lease is live", () => {
    const root = project();
    const s = startNew(root, "A");
    const other = takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.error.code).toBe("conflict");
      expect(other.error.message).toContain(s.worktree); // names the holder
    }
  });

  test("BR-2011: through the CLI a start of a change with a live claim is refused with exit 5, the holder's own actor included", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Held\nstatus: open\n---\n## 为什么\n\nHeld.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "planned change");
    const started = start(ws(root, "agent:a"), { change: "C-1" }, quiet);
    if (!started.ok) throw new Error(started.error.message);
    const s = started.value;
    const cli = (actor: string) => Bun.spawnSync(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "start", s.change], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
    const other = cli("agent:b");
    expect(other.exitCode).toBe(5);
    expect(other.stderr.toString()).toContain("claimed by agent:a");
    expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:a"]]);
    // Subagents of one Claude Code session share the actor, so the same actor is refused too, and told to pick another change, not to go in.
    const same = cli("agent:a");
    expect(same.exitCode).toBe(5);
    expect(same.stderr.toString()).toContain("it is in progress in that worktree: if you did not start it in this conversation, pick another change");
    expect(same.stderr.toString()).not.toContain("cd ");
    expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:a"]]);
  });

  test("BR-2104: in a worktree another actor holds, stop, stop --release and land are refused with exit 5; nothing changes", () => {
    const root = project();
    const s = startNew(root, "Held here");
    const before = sh(root, "rev-parse", "main");
    const cli = (actor: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", ...args], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
    for (const args of [["stop", "--release", "--next", "x"], ["stop", "--next", "x"], ["land", "--finish"]]) {
      const r = cli("agent:b", ...args);
      expect(r.exitCode).toBe(5);
      expect(r.stderr.toString()).toContain("claimed by agent:a");
    }
    expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:a"]]);
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()?.n).toBe(0);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'land.refuse'").get()?.n).toBe(0);
    expect(cli("agent:a", "stop", "--release", "--next", "x").exitCode).toBe(0);
    expect(claims(ws(root).db)).toEqual([]);
  });

  test("BR-2104: another agent of the holder's session acts as the holder in its worktree; canon does not tell them apart", () => {
    const root = project();
    const s = startNew(root, "Same session");
    const db = ws(root).db;
    const before = claims(db)[0]!.expires_at;
    // A second subagent of the same session has the same actor (BR-2023): in the holder's worktree it is the holder.
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "stop", "--next", "x"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(r.exitCode).toBe(0);
    expect(claims(db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:a"]]);
    expect(claims(db)[0]!.expires_at >= before).toBe(true);
    expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'claim.refuse'").get()?.n).toBe(0);
  });

  test("BR-2131: every event records the worktree it was run from, so one session's agents in different worktrees are told apart", () => {
    const root = project();
    const a = startNew(root, "First");
    const b = startNew(root, "Second");
    expect(stop(ws(a.worktree), "next a", undefined, false).ok).toBe(true);
    expect(stop(ws(b.worktree), "next b", undefined, false).ok).toBe(true);
    const db = ws(root).db;
    const rows = db.db.query<{ actor: string; kind: string; subject: string | null; worktree: string | null }, []>("SELECT actor, kind, subject, worktree FROM events ORDER BY id").all();
    const main = ws(root).root;
    expect(rows.filter((e) => e.kind === "id.allocate").map((e) => e.worktree)).toEqual([main, main]);
    const renews = rows.filter((e) => e.kind === "claim.renew");
    expect(renews.map((e) => [e.actor, e.subject, e.worktree])).toEqual([
      ["agent:a", a.change, ws(a.worktree).root],
      ["agent:a", b.change, ws(b.worktree).root],
    ]);
    expect(rows.every((e) => e.worktree !== null)).toBe(true);
  });

  test("BR-2104: once the holder's lease has expired, another actor's stop in that worktree takes the claim over", () => {
    const root = project();
    const s = startNew(root, "Expired here");
    const db = ws(root).db;
    db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(Date.now() - 60_000).toISOString(), s.change);
    expect(stop(ws(s.worktree, "agent:b"), "carry on", undefined, false).ok).toBe(true);
    expect(claims(db).map((c) => c.actor)).toEqual(["agent:b"]);
  });

  test("BR-2107: a change that exists only on its branch is resumed by id: in its worktree, or in a new one from the branch", () => {
    const root = project();
    const s = startNew(root, "Only on branch");
    writeFileSync(join(s.worktree, "wip.txt"), "wip\n");
    sh(s.worktree, "add", "wip.txt");
    sh(s.worktree, "commit", "-qm", "wip");
    const db = ws(root).db;
    const expire = () => db.db.query("UPDATE claims SET expires_at = ?").run(new Date(Date.now() - 60_000).toISOString());
    const cli = (actor: string) => Bun.spawnSync(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "start", s.change], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });

    const held = cli("agent:b"); // agent:a's claim is live
    expect(held.exitCode).toBe(5);

    expire(); // agent:a's session ended without a handoff
    const inPlace = cli("agent:b");
    expect(inPlace.exitCode).toBe(0);
    expect(inPlace.stdout.toString()).toContain(`cd ${s.worktree}`);
    expect(claims(db).map((c) => [c.subject, c.actor, c.holder])).toEqual([[s.change, "agent:b", s.worktree]]);

    expire();
    sh(root, "worktree", "remove", s.worktree);
    const fresh = cli("agent:c");
    expect(fresh.exitCode).toBe(0);
    expect(readFileSync(join(s.worktree, "wip.txt"), "utf8")).toBe("wip\n");
    expect(sh(s.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(s.branch);
  });

  test("BR-2107: an id with neither a change on main nor a change branch is not found; a lookalike branch does not count", () => {
    const root = project();
    sh(root, "branch", "change/C-12-other");
    const r = start(ws(root), { change: "C-1" }, quiet);
    expect(!r.ok && r.error.code).toBe("not_found");
  });

  test("BR-2107: a change branch whose name holds shell syntax is read without running it", () => {
    const root = project();
    const s = startNew(root, "Odd name");
    stop(ws(s.worktree), "x", undefined, true);
    sh(root, "worktree", "remove", s.worktree);
    const marker = join(root, "..", `${root.split("/").pop()}-ran`);
    const odd = `change/${s.change}-$(touch${"${IFS}"}${marker})`;
    sh(root, "branch", "-m", s.branch, odd);
    const r = start(ws(root, "agent:b"), { change: s.change }, quiet);
    expect(r.ok && r.value.branch).toBe(odd);
    expect(existsSync(marker)).toBe(false);
  });

  // A drop that runs to completion between start reading the branch and start taking the claim (issue #20).
  const dropBeforeClaim = (root: string, s: { worktree: string; branch: string }, removeBranch: boolean) => {
    const w = ws(root, "agent:b");
    const tx = w.db.db.transaction.bind(w.db.db);
    let once = false;
    w.db.db.transaction = ((fn: Parameters<typeof tx>[0]) => {
      if (!once) {
        once = true;
        sh(root, "worktree", "remove", "--force", s.worktree);
        if (removeBranch) sh(root, "branch", "-q", "-D", s.branch);
      }
      return tx(fn);
    }) as typeof tx;
    return w;
  };

  test("BR-2136: a branch deleted between reading it and taking the claim is not found, and nothing is created", () => {
    const root = project();
    const s = startNew(root, "Dropped meanwhile");
    stop(ws(s.worktree), "x", undefined, true);
    const r = start(dropBeforeClaim(root, s, true), { change: s.change }, quiet);
    expect(!r.ok && r.error.code).toBe("not_found");
    expect(git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${s.branch}`).ok).toBe(false);
    expect(existsSync(s.worktree)).toBe(false);
    expect(claims(ws(root).db)).toEqual([]);
  });

  test("BR-2136: a branch still there after the claim, with only its worktree gone, is resumed from the branch", () => {
    const root = project();
    const s = startNew(root, "Worktree gone meanwhile");
    stop(ws(s.worktree), "x", undefined, true);
    const r = start(dropBeforeClaim(root, s, false), { change: s.change }, quiet);
    expect(r.ok && r.value.branch).toBe(s.branch);
    expect(existsSync(s.worktree)).toBe(true);
    expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
  });

  test("BR-2107: two branches for one change are refused as invalid, listing both", () => {
    const root = project();
    sh(root, "branch", "change/C-1-a");
    sh(root, "branch", "change/C-1-b");
    const r = start(ws(root), { change: "C-1" }, quiet);
    expect(!r.ok && r.error.code).toBe("invalid");
    expect(!r.ok && r.error.message).toContain("change/C-1-a, change/C-1-b");
  });

  test("BR-2011: work commands in the holding worktree renew the lease, so a long session is never taken over", async () => {
    const root = project();
    const s = startNew(root, "Long");
    const db = ws(root).db;
    const expire = () => db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(Date.now() - 3600_000).toISOString(), s.change);
    const expiry = () => new Date(claims(db)[0]!.expires_at).getTime();
    expire();
    expect(stop(ws(s.worktree), "keep going", undefined, false).ok).toBe(true);
    expect(expiry()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expire();
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    await land(ws(s.worktree), FAST, quiet);
    expect(expiry()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expect(takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b").ok).toBe(false);
  });

  test("BR-2011: claim_lease_hours sets the lease", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nclaim_lease_hours: 1\n");
    sh(root, "commit", "-qam", "short lease");
    const s = startNew(root, "Short");
    const left = new Date(claims(ws(root).db)[0]!.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    expect(s.change).toBe("C-1");
  });

  test("BR-2047: worktrees go where `worktrees` says, relative to the primary checkout; clean only looks there", () => {
    const root = project();
    const old = startNew(root, "Old place");
    stop(ws(old.worktree), "x", undefined, true);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nworktrees: ../${root.split("/").pop()}-wt\n`);
    sh(root, "commit", "-qam", "move worktrees");
    const s = startNew(root, "New place");
    expect(s.worktree).toBe(join(realpathSync(root), "..", `${root.split("/").pop()}-wt`, s.change));
    expect(existsSync(s.worktree)).toBe(true);
    const r = clean(ws(root), quiet);
    expect(r.ok && [...r.value.removed, ...r.value.kept].join("\n")).not.toContain(old.worktree);
    expect(existsSync(old.worktree)).toBe(true);
  });

  test("BR-2011: once the lease has expired another worktree can take the change over", () => {
    const root = project();
    const s = startNew(root, "A");
    const db = ws(root, "agent:b").db;
    db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(Date.now() - 13 * 3600_000).toISOString(), s.change);
    expect(takeClaim(db, s.change, "/elsewhere", "agent:b").ok).toBe(true);
    expect(claims(db).map((c) => c.holder)).toEqual(["/elsewhere"]);
  });
});

describe("clean keeps what git does not show", () => {
  async function landed(root: string, title: string) {
    const s = startNew(root, title);
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    if (out.kind !== "landed") throw new Error(`expected landed, got ${out.kind}`);
    return s;
  }
  function ignoring(root: string, extraConfig = "") {
    writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\ncache-*/\n");
    writeFileSync(join(root, "canon/config.yaml"), `floor: test ! -e FAIL\ntests: []\n${extraConfig}`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "ignore");
  }

  test("BR-2019: a landed worktree holding an ignored .env is kept; one holding only node_modules is removed", async () => {
    const root = project();
    ignoring(root);
    const secret = await landed(root, "Has env");
    writeFileSync(join(secret.worktree, ".env"), "TOKEN=1\n");
    const deps = await landed(root, "Has deps");
    mkdirSync(join(deps.worktree, "node_modules/x"), { recursive: true });
    writeFileSync(join(deps.worktree, "node_modules/x/i.js"), "1\n");
    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([deps.worktree]);
    expect(existsSync(join(secret.worktree, ".env"))).toBe(true);
    expect(r.value.kept.join("\n")).toContain(`${secret.worktree}: ignored files that cannot be regenerated: .env`);
  });

  test("BR-2179: canon's generated .canon is regenerable even when regenerable does not list it; a .env beside it is still work", async () => {
    const root = project();
    ignoring(root, "regenerable: [node_modules]\n");
    const only = await landed(root, "Only schema");
    const w = writeSchemaFile(only.worktree);
    if (!w.ok) throw new Error(w.error.message);
    const both = await landed(root, "Schema and env");
    if (!writeSchemaFile(both.worktree).ok) throw new Error("cannot write the schema");
    writeFileSync(join(both.worktree, ".env"), "TOKEN=1\n");
    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([only.worktree]);
    const kept = r.value.kept.join("\n");
    expect(kept).toContain(`${both.worktree}: ignored files that cannot be regenerated: .env`);
    expect(kept).not.toContain(".canon");
  });

  test("BR-2019: names listed under regenerable replace the default list", async () => {
    const root = project();
    ignoring(root, "regenerable: [\"cache-*\"]\n");
    const cache = await landed(root, "Has cache");
    mkdirSync(join(cache.worktree, "cache-v1"), { recursive: true });
    writeFileSync(join(cache.worktree, "cache-v1/blob"), "1\n");
    const deps = await landed(root, "Has deps");
    mkdirSync(join(deps.worktree, "node_modules"), { recursive: true });
    writeFileSync(join(deps.worktree, "node_modules/i.js"), "1\n");
    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([cache.worktree]);
    expect(r.value.kept.join("\n")).toContain(`${deps.worktree}: ignored files that cannot be regenerated: node_modules/`);
  });

  test.skipIf(process.platform === "linux")("BR-2019: when processes cannot be listed a landed worktree is kept, saying so", async () => {
    const root = project();
    const s = await landed(root, "No lsof");
    const bin = mkdtempSync(join(tmpdir(), "canon-nolsof-"));
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    try {
      const r = clean(ws(root), quiet);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.removed).toEqual([]);
      expect(r.value.kept.join("\n")).toContain(`${s.worktree}: cannot tell whether a process is inside it`);
    } finally {
      process.env["PATH"] = path;
    }
  });

  test.skipIf(process.platform === "linux")("BR-2019: a worktree claimed after clean read the claims is kept, and clean leaves no claim behind", async () => {
    const root = project();
    const s = await landed(root, "Claimed meanwhile");
    const other = await landed(root, "Free");
    const db = ws(root).db.db.filename;
    // A stand-in for lsof that, while clean waits for it, lets another session claim the first worktree.
    const bin = mkdtempSync(join(tmpdir(), "canon-racelsof-"));
    const insert = `INSERT INTO claims(subject, holder, worktree, expires_at) VALUES ('${s.change}', 'agent:b', '${s.worktree}', '2999-01-01T00:00:00.000Z')`;
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\nsqlite3 ${JSON.stringify(db)} ${JSON.stringify(insert)}\nexit 0\n`, { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    try {
      const r = clean(ws(root), quiet);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.removed).toEqual([other.worktree]);
      expect(r.value.kept).toContain(`${s.worktree}: claimed`);
      expect(existsSync(s.worktree)).toBe(true);
      expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
    } finally {
      process.env["PATH"] = path;
    }
  });

  test("BR-2019: a landed worktree that another process has as its current directory is kept, naming the pid", async () => {
    const root = project();
    const s = await landed(root, "Busy");
    const proc = Bun.spawn(["sleep", "30"], { cwd: s.worktree });
    try {
      const r = clean(ws(root), quiet);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.removed).toEqual([]);
      expect(r.value.kept.join("\n")).toContain(`${s.worktree}: in use by pid ${proc.pid} (sleep)`);
    } finally {
      proc.kill();
      await proc.exited;
    }
    const after = clean(ws(root), quiet);
    expect(after.ok && after.value.removed).toEqual([s.worktree]);
  });
});

describe("same-file overlap", () => {
  const commitFile = (wt: string, file: string, text: string) => {
    writeFileSync(join(wt, file), text);
    sh(wt, "add", file);
    sh(wt, "commit", "-qm", file);
  };
  const notices = (root: string) =>
    ws(root).db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'overlap.notice' ORDER BY id").all().map((e) => ({ subject: e.subject, ...JSON.parse(e.detail) }));

  test("BR-2062: landing a change that shares a committed file with another change prints and records a notice, and still lands", async () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    const c = startNew(root, "C");
    commitFile(a.worktree, "shared.txt", "a\n");
    commitFile(b.worktree, "shared.txt", "b\n");
    commitFile(c.worktree, "other.txt", "c\n");
    writeFileSync(join(c.worktree, "shared.txt"), "uncommitted\n");
    const lines: string[] = [];
    const out = await land(ws(a.worktree), FAST, (l) => lines.push(l));
    expect(out.kind).toBe("landed");
    expect(lines.filter((l) => l.startsWith("overlap:"))).toEqual([`overlap: ${b.change} also changes shared.txt; whoever lands second resolves the conflict`]);
    expect(notices(root)).toEqual([{ subject: a.change, at: "land", with: b.change, files: ["shared.txt"] }]);
  });

  test("BR-2062: a landing refused before the queue (uncommitted work) prints no overlap notice", async () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    commitFile(a.worktree, "shared.txt", "a\n");
    commitFile(b.worktree, "shared.txt", "b\n");
    writeFileSync(join(a.worktree, "dirty.txt"), "x\n");
    const lines: string[] = [];
    expect((await land(ws(a.worktree), FAST, (l) => lines.push(l))).kind).toBe("refused");
    expect(lines.some((l) => l.startsWith("overlap:"))).toBe(false);
    expect(notices(root)).toEqual([]);
  });

  test("BR-2062: restarting a change whose branch already overlaps another prints the notice; a fresh change does not", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Planned\nstatus: open\n---\n## 为什么\n\nPlanned.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "planned change");
    const a = start(ws(root), { change: "C-1" }, quiet);
    if (!a.ok) throw new Error(a.error.message);
    const fresh: string[] = [];
    const b = start(ws(root), { title: "B" }, (l) => fresh.push(l));
    if (!b.ok) throw new Error(b.error.message);
    expect(fresh.some((l) => l.startsWith("overlap:"))).toBe(false);
    commitFile(a.value.worktree, "shared.txt", "a\n");
    commitFile(b.value.worktree, "shared.txt", "b\n");
    const lines: string[] = [];
    stop(ws(a.value.worktree), "resume later", undefined, true); // a live claim refuses every start (BR-2011)
    expect(start(ws(root), { change: "C-1" }, (l) => lines.push(l)).ok).toBe(true);
    expect(lines.filter((l) => l.startsWith("overlap:"))).toEqual([`overlap: ${b.value.change} also changes shared.txt; whoever lands second resolves the conflict`]);
    expect(notices(root)).toEqual([{ subject: "C-1", at: "start", with: b.value.change, files: ["shared.txt"] }]);
  });
});

describe("concurrent starts", () => {
  test("BR-2132: 8 concurrent CLI starts of different new changes all succeed and write no upstream config, even with origin/main present", async () => {
    const root = project();
    const remote = mkdtempSync(join(tmpdir(), "canon-next-remote-"));
    sh(remote, "init", "-q", "--bare");
    sh(root, "remote", "add", "origin", remote);
    sh(root, "push", "-q", "origin", "main");
    sh(root, "fetch", "-q", "origin");
    expect(sh(root, "rev-parse", "--verify", "refs/remotes/origin/main")).not.toBe("");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "start", "--title", `Parallel ${i}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: `agent:p${i}` } }),
    );
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    const wts = sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes(".worktrees/"));
    expect(wts.length).toBe(8);
    expect(new Set(claims(ws(root).db).map((c) => c.subject)).size).toBe(8);
    const upstream = git(root, "config", "--get-regexp", "^branch\\.change/");
    expect(upstream.ok ? upstream.value : "").toBe("");
  }, 60_000);
});

describe("clean named changes", () => {
  async function landed(root: string, title: string) {
    const s = startNew(root, title);
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    if (out.kind !== "landed") throw new Error(`expected landed, got ${out.kind}`);
    return s;
  }
  const cli = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "clean", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("BR-2152: only the named change's worktree is removed; another landed one stays and is not listed", async () => {
    const root = project();
    const one = await landed(root, "One");
    const two = await landed(root, "Two");
    const r = clean(ws(root), quiet, [one.change, one.change]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([one.worktree]);
    expect(r.value.kept).toEqual([]);
    expect(existsSync(two.worktree)).toBe(true);
  });

  test("BR-2152: a named change with unlanded work is kept with the BR-2019 reason; one without a worktree is listed as such", async () => {
    const root = project();
    const gone = await landed(root, "Gone");
    sh(root, "worktree", "remove", gone.worktree);
    const busy = startNew(root, "Busy");
    stop(ws(busy.worktree), "later", undefined, true);
    const r = clean(ws(root), quiet, [busy.change, gone.change]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([]);
    expect(r.value.kept).toEqual([`${gone.change}: no worktree`, `${busy.worktree}: 1 commit(s) not on main`]);
  });

  test("BR-2152: a name that is not a change removes nothing", async () => {
    const root = project();
    const one = await landed(root, "One");
    const r = clean(ws(root), quiet, [one.change, "C-99"]);
    expect(r.ok ? "removed" : `${r.error.code}: ${r.error.message}`).toBe("not_found: C-99 is not a change: nothing was removed");
    expect(existsSync(one.worktree)).toBe(true);
  });

  test("BR-2152 BR-2022: from the CLI any number of changes may be named; a non-change exits 3; no names keeps cleaning everything", async () => {
    const root = project();
    const one = await landed(root, "One");
    const two = await landed(root, "Two");
    const three = await landed(root, "Three");
    const bad = cli(root, one.change, "foo");
    expect([bad.code, bad.err]).toEqual([3, "canon: foo is not a change: nothing was removed\n"]);
    expect(existsSync(one.worktree)).toBe(true);
    const named = cli(root, one.change, two.change);
    expect([named.code, named.out]).toEqual([0, `removed ${one.worktree}\nremoved ${two.worktree}\n`]);
    expect(existsSync(three.worktree)).toBe(true);
    const all = cli(root);
    expect([all.code, all.out]).toEqual([0, `removed ${three.worktree}\n`]);
  }, 30_000); // reason: four spawned CLI runs plus three landings; the CLI surface is what it tests (C-111)
});
