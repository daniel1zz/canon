import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claims, holdClaim, takeClaim } from "../claims/claims.ts";
import { processOf } from "../claims/liveness.ts";
import { clean, start, startChore, stop } from "./session.ts";
import { firstLine, handoffs } from "./handoffs.ts";
import { writeSchemaFile } from "../../invocation/reference/reference.ts";
import { land } from "../land/land.ts";
import { addWorktree, git, listWorktreesLocked, withWorktreeLock } from "../../kernel/git.ts";

import { hang, FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

describe("work start", () => {
  test("BR-2022: start of a change that is nowhere exits 3; when git cannot read main it exits 4, naming main (issue #77)", () => {
    const root = project();
    const cli = () => Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", "C-99"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(cli().exitCode).toBe(3);
    sh(root, "checkout", "-q", "-b", "other"); // no worktree has main out, so it is read from git
    writeFileSync(join(root, "canon/config.yaml"), "main: nope\nfloor: test ! -e FAIL\ntests: []\n");
    const r = cli();
    expect(r.exitCode).toBe(4);
    expect(r.stderr.toString()).toContain("git cannot read nope");
  });

  test("BR-2012 BR-2022 BR-2002: on a repository with no commit start exits 4 before allocating, and the first start after the commit gets C-1 (issue #123)", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-unborn-"));
    sh(root, "init", "-q", "-b", "main");
    sh(root, "config", "user.email", "t@t");
    sh(root, "config", "user.name", "t");
    const cli = (...args: string[]) => {
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    expect(cli("init", "--floor", "true").code).toBe(0);
    for (const args of [["work", "start", "--title", "x"], ["work", "start", "C-1"]]) {
      const r = cli(...args);
      expect(r.code).toBe(4);
      expect(r.err).toContain("main has no commit yet");
      expect(r.err).toContain('git commit -m "canon init"');
      expect(r.err).not.toContain("invalid reference");
    }
    expect(cli("events").out).not.toContain("id.allocate");
    expect(existsSync(`${root}.worktrees`)).toBe(false);
    sh(root, "add", "canon", ".claude");
    sh(root, "commit", "-qm", "canon init");
    const ok = cli("work", "start", "--title", "x");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("C-1 →");
    rmSync(`${root}.worktrees`, { recursive: true, force: true });
  }, 180_000); // six CLI processes, each slow when the machine is loaded

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
    const cli = (actor: string) => Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", s.change], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
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
    const cli = (actor: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", ...args], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
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
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "stop", "--next", "x"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
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
    const cli = (actor: string) => Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", s.change], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });

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

  test("BR-2019: a landed worktree whose claim expired or whose session process exited is removed with that claim; one with a live claim is kept", async () => {
    const root = project();
    const expired = await landed(root, "Expired");
    const gone = await landed(root, "Gone");
    const live = await landed(root, "Live");
    const db = ws(root).db;
    const dead = hang();
    const proc = processOf(dead.pid);
    if (!proc) throw new Error("no start time for a live child");
    dead.kill("SIGKILL");
    await dead.exited;
    const put = db.db.query("INSERT INTO claims(subject, holder, worktree, expires_at, pid, pid_start) VALUES (?, 'agent:b', ?, ?, ?, ?)");
    put.run(expired.change, expired.worktree, "2000-01-01T00:00:00.000Z", null, null);
    put.run(gone.change, gone.worktree, "2999-01-01T00:00:00.000Z", proc.pid, proc.start);
    put.run(live.change, live.worktree, "2999-01-01T00:00:00.000Z", null, null);
    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed.sort()).toEqual([expired.worktree, gone.worktree].sort());
    expect(r.value.kept).toContain(`${live.worktree}: claimed`);
    expect(claims(ws(root).db).map((c) => c.subject)).toEqual([live.change]);
  });

  test("BR-2019: a landed worktree that another process has as its current directory is kept, naming the pid", async () => {
    const root = project();
    const s = await landed(root, "Busy");
    const proc = hang({ cwd: s.worktree });
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

  test("BR-2062 BR-2241: a --finish landing refused for missing evidence prints no overlap notice", async () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    commitFile(b.worktree, "shared.txt", "b\n");
    mkdirSync(join(a.worktree, "canon/rules/billing"), { recursive: true });
    const id = ["BR", 1].join("-");
    commitFile(a.worktree, `canon/rules/billing/${id}.md`, `---\nid: ${id}\ntitle: Refund\nuntested: provider\n---\n## 规则\n\nRefunds go back.\n\n## 例子\n\n- refund → shown\n`);
    commitFile(a.worktree, "shared.txt", "a\n");
    const lines: string[] = [];
    const out = await land(ws(a.worktree), { ...FAST, finish: true }, (l) => lines.push(l));
    expect(out.kind === "refused" && out.reason).toBe("evidence");
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
      Bun.spawn(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", "--title", `Parallel ${i}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: `agent:p${i}` } }),
    );
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    const wts = sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes(".worktrees/"));
    expect(wts.length).toBe(8);
    expect(new Set(claims(ws(root).db).map((c) => c.subject)).size).toBe(8);
    const upstream = git(root, "config", "--get-regexp", "^branch\\.change/");
    expect(upstream.ok ? upstream.value : "").toBe("");
  }, 60_000);

  test("BR-2132: with git's branch.autoSetupMerge=always, 8 concurrent CLI starts still all succeed and write no upstream config (issue #27)", async () => {
    const root = project();
    sh(root, "config", "branch.autoSetupMerge", "always"); // git then tracks even a local start point
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", "--title", `Always ${i}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: `agent:a${i}` } }),
    );
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    expect(new Set(claims(ws(root).db).map((c) => c.subject)).size).toBe(8);
    const upstream = git(root, "config", "--get-regexp", "^branch\\.change/");
    expect(upstream.ok ? upstream.value : "").toBe("");
  }, 60_000);

  // Another canon process inside the worktree lock, leaving .git/worktrees/half as git does midway through an add:
  // gitdir written, commondir created but still empty. A plain `git worktree add` meanwhile dies on it (issue #32).
  const HOLDER = `
    import { mkdirSync, rmSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { withWorktreeLock } from ${JSON.stringify(join(import.meta.dir, "../../kernel/git.ts"))};
    const root = process.env.ROOT, half = join(root, ".git/worktrees/half");
    const r = withWorktreeLock(root, "change", () => {
      mkdirSync(half, { recursive: true });
      writeFileSync(join(half, "gitdir"), root + ".wt/half/.git\\n");
      writeFileSync(join(half, "commondir"), "");
      writeFileSync(process.env.MARK, "in");
      Bun.sleepSync(Number(process.env.HOLD_MS));
      rmSync(half, { recursive: true, force: true });
      writeFileSync(process.env.MARK, "out " + Date.now());
    });
    process.exit(r.ok ? 0 : 9);
  `;
  const holder = (root: string, holdMs: number) => {
    const mark = join(mkdtempSync(join(tmpdir(), "canon-next-mark-")), "mark");
    const p = Bun.spawn(["bun", "-e", HOLDER], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ROOT: root, MARK: mark, HOLD_MS: String(holdMs) } });
    return { p, mark };
  };
  const inside = async (h: { p: Bun.Subprocess<"ignore", "pipe", "pipe">; mark: string }) => {
    for (let i = 0; i < 500 && !(existsSync(h.mark) && readFileSync(h.mark, "utf8") !== ""); i++) await Bun.sleep(20);
    if (!existsSync(h.mark)) throw new Error(`holder never got the lock: ${await new Response(h.p.stderr).text()}`);
    expect(readFileSync(h.mark, "utf8")).toBe("in");
  };
  const cliStart = (root: string, title: string) =>
    Bun.spawn(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "start", "--title", title], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:w" } });

  test("BR-2223: a start while another canon process is midway through creating a worktree waits for it and succeeds", async () => {
    const root = project();
    mkdirSync(join(root, ".git/worktrees"), { recursive: true });
    const h = holder(root, 2_000);
    await inside(h);
    expect(Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "plain", `${root}.wt/plain`, "main"], { cwd: root, stderr: "pipe" }).stderr.toString()).toContain("failed to read");
    const s = cliStart(root, "Waits");
    const code = await s.exited;
    const done = Date.now();
    expect({ code, err: await new Response(s.stderr).text() }).toEqual({ code: 0, err: expect.any(String) });
    expect(await h.p.exited).toBe(0);
    const released = Number(readFileSync(h.mark, "utf8").replace(/^out /, ""));
    expect(released).toBeLessThanOrEqual(done); // it ran its git worktree add only after the other process let go
    expect(existsSync(join(root, ".git/worktrees/half"))).toBe(false);
    expect(claims(ws(root).db).map((c) => c.subject)).toEqual(["C-1"]);
  }, 60_000);

  test("BR-2223: git worktree add and list through canon wait out another process's unfinished add, where plain git dies on it", async () => {
    const root = project();
    const h = holder(root, 1_500);
    await inside(h);
    const plain = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: root, stderr: "pipe" });
    expect(plain.stderr.toString()).toContain("failed to read .git/worktrees/half/commondir");
    const added = addWorktree(root, "-q", "-b", "after", `${root}.wt/after`, "main");
    const done = Date.now();
    expect(added.ok).toBe(true);
    expect(Number(readFileSync(h.mark, "utf8").replace(/^out /, ""))).toBeLessThanOrEqual(done);
    expect(await h.p.exited).toBe(0);
    const h2 = holder(root, 1_500);
    await inside(h2);
    const listed = listWorktreesLocked(root);
    expect(listed.ok ? listed.value.map((w) => w.branch) : listed.error.message).toEqual(["main", "after"]);
    expect(await h2.p.exited).toBe(0);
  }, 60_000);

  test("BR-2223: a canon run from a git hook of a locked worktree add does not wait on its own parent", () => {
    const root = project();
    const hooks = mkdtempSync(join(tmpdir(), "canon-next-hooks-"));
    const out = join(hooks, "out");
    const script = `import { listWorktreesLocked } from ${JSON.stringify(join(import.meta.dir, "../../kernel/git.ts"))}; const r = listWorktreesLocked(process.cwd()); require("node:fs").writeFileSync(${JSON.stringify(out)}, String(r.ok));`;
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nexec bun -e ${JSON.stringify(script).replace(/\$/g, "\\$")}\n`, { mode: 0o755 });
    sh(root, "config", "core.hooksPath", hooks);
    const t0 = Date.now();
    const added = addWorktree(root, "-q", "-b", "hooked", `${root}.wt/hooked`, "main");
    expect(added.ok ? "ok" : added.error.message).toBe("ok");
    expect(readFileSync(out, "utf8")).toBe("true");
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  test("BR-2223: a wait for the worktree lock that runs out fails as an environment error naming the lock file", async () => {
    const root = project();
    const h = holder(root, 3_000);
    await inside(h);
    const r = withWorktreeLock(root, "read", () => "read", 300);
    expect(r.ok ? "ok" : [r.error.code, r.error.message.includes(join(".git", "canon", "worktree.lock")), r.error.message.startsWith("waited 300 ms")]).toEqual(["io", true, true]);
    expect(await h.p.exited).toBe(0);
    expect(withWorktreeLock(root, "read", () => "read", 300)).toEqual({ ok: true, value: "read" });
  }, 60_000);

  test("BR-2223: a process that died while creating a worktree does not hold up the next start", async () => {
    const root = project();
    const h = holder(root, 120_000);
    await inside(h);
    h.p.kill("SIGKILL");
    await h.p.exited;
    rmSync(join(root, ".git/worktrees/half"), { recursive: true, force: true });
    const t0 = Date.now();
    const s = cliStart(root, "After crash");
    expect(await s.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
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
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "clean", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
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

describe("start and clean leave nothing half made", () => {
  const startEvents = (root: string) =>
    ws(root).db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'start.refuse' ORDER BY id").all().map((e) => [e.subject, JSON.parse(e.detail).reason]);
  const hasBranch = (root: string, branch: string) => git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;

  test("BR-2012 BR-2047: by default the branch is change/<C-n>-<slug> and the worktree is <primary>.worktrees/<C-n>; a long title's slug is cut at 60 characters", () => {
    const root = project();
    const s = startNew(root, "Refund window");
    expect(s.branch).toBe("change/C-1-refund-window");
    expect(s.worktree).toBe(`${realpathSync(root)}.worktrees/C-1`);
    expect(sh(s.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("change/C-1-refund-window");
    const long = startNew(root, "a".repeat(100));
    expect(long.branch).toBe(`change/C-2-${"a".repeat(60)}`);
    expect(hasBranch(root, long.branch)).toBe(true);
  });

  test("BR-2029: after a failed setup is fixed, starting again creates the worktree and runs setup again", () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-setup-ran`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nsetup: "echo run >> ${marker}; test -e .ok"\n`);
    sh(root, "commit", "-qam", "setup that fails");
    expect(start(ws(root), { title: "Needs setup" }, quiet).ok).toBe(false);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nsetup: "echo run >> ${marker}"\n`);
    sh(root, "commit", "-qam", "setup that passes");
    const again = start(ws(root), { title: "Needs setup" }, quiet);
    expect(again.ok).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
    if (again.ok) expect(existsSync(again.value.worktree)).toBe(true);
  });

  test("BR-2029 BR-2026: a change file that cannot be committed removes the new worktree, branch and claim, and is recorded", () => {
    const root = project();
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = start(ws(root), { title: "Blocked" }, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    expect(sh(root, "worktree", "list").split("\n").length).toBe(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    expect(claims(ws(root).db)).toEqual([]);
    expect(startEvents(root)).toEqual([["C-1", "change-file"]]);
  });

  test("BR-2026: a worktree that cannot be created releases the claim and is recorded with its own reason", () => {
    const root = project();
    writeFileSync(`${realpathSync(root)}.worktrees`, "a file where the worktree directory goes\n");
    const r = start(ws(root), { title: "No room" }, quiet);
    expect(!r.ok && r.error.code).toBe("io");
    expect(claims(ws(root).db)).toEqual([]);
    expect(startEvents(root)).toEqual([["C-1", "worktree"]]);
  });

  test("BR-2062: a refused start prints no overlap and records no overlap.notice", () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    for (const wt of [a.worktree, b.worktree]) {
      writeFileSync(join(wt, "shared.txt"), `${wt}\n`);
      sh(wt, "add", "shared.txt");
      sh(wt, "commit", "-qm", "shared");
    }
    const lines: string[] = [];
    const r = start(ws(root, "agent:b"), { change: a.change }, (l) => lines.push(l));
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(lines.some((l) => l.startsWith("overlap:"))).toBe(false);
    expect(ws(root).db.db.query("SELECT 1 FROM events WHERE kind = 'overlap.notice'").all()).toEqual([]);
  });

  test("BR-2019: a clean killed while it removed a worktree leaves a hold that does not stop a later start", async () => {
    const root = project();
    const s = startNew(root, "Killed clean");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    stop(ws(s.worktree), "done for now", undefined, true);
    const w = ws(root);
    if (!holdClaim(w.db, s.change, s.worktree, "agent:a").ok) throw new Error("hold refused");
    const p = hang();
    const dead = processOf(p.pid);
    if (!dead) throw new Error("no start time for a live child");
    p.kill("SIGKILL");
    await p.exited;
    w.db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(dead.pid, dead.start, s.change);
    sh(root, "worktree", "remove", s.worktree); // killed after git removed it, before the hold was let go
    const again = start(ws(root, "agent:b"), { change: s.change }, quiet);
    expect(again.ok).toBe(true);
    expect(claims(ws(root).db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
  });

  test("BR-2152: a change id in lower case names the same change as in upper case", async () => {
    const root = project();
    const s = startNew(root, "Lower");
    expect((await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    const r = clean(ws(root), quiet, [s.change.toLowerCase(), s.change]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([s.worktree]);
    expect(r.value.kept).toEqual([]);
  });

  test("BR-2188: clean deletes a removed worktree's branch, keeps a kept one's, and deletes a landed branch even when the primary checkout is on a branch without it", async () => {
    const root = project();
    const one = startNew(root, "One");
    expect((await land(ws(one.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    const busy = startNew(root, "Busy");
    stop(ws(busy.worktree), "later", undefined, true);
    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([one.worktree]);
    expect(hasBranch(root, one.branch)).toBe(false);
    expect(hasBranch(root, busy.branch)).toBe(true);
    // The primary checkout on a branch without the landed commits: `git branch -d` would refuse; the branch is on main, so it goes.
    sh(root, "checkout", "-q", "-b", "other", "main~2");
    const three = startNew(root, "Three");
    expect((await land(ws(three.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    const lines: string[] = [];
    const again = clean(ws(root), (l) => lines.push(l), [three.change]);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.removed).toEqual([three.worktree]);
    expect(lines).toEqual([`removed ${three.worktree}`]);
    expect(hasBranch(root, three.branch)).toBe(false);
  });
});

describe("no new change while review work is owed", () => {
  const owe = (root: string) => {
    const db = ws(root).db;
    const add = (id: number) => db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at) VALUES (?, 'contradiction', '[]', '[]', 'x contradicts y', 'C-9', 1, 'abc', ?)").run(`identity-${id}`, new Date().toISOString());
    add(1);
    add(2);
    return db;
  };
  const changesIn = (root: string) => sh(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/");

  test("BR-2464: open findings refuse a new change with exit 1 and a debt event, and leave no id, worktree or claim; a chore, a change already started and the fix of main go on", () => {
    const root = project();
    const before = startNew(root, "Started earlier");
    const db = owe(root);
    const r = start(ws(root), { title: "New feature" }, quiet);
    expect(r.ok ? "" : r.error.code).toBe("refused");
    expect(r.ok ? "" : r.error.message).toContain("2 open review finding(s) (#1, #2)");
    expect(r.ok ? "" : r.error.message).toContain("canon chore start");
    expect(changesIn(root).split("\n").filter((l) => l !== "")).toEqual([before.branch]);
    expect(claims(db).map((c) => c.subject)).toEqual([before.change]); // nothing new claimed
    expect(db.db.query<{ d: string }, []>("SELECT json_extract(detail, '$.reason') AS d FROM events WHERE kind = 'start.refuse'").all().map((x) => x.d)).toEqual(["debt"]);
    stop(ws(before.worktree), "hand over", undefined, true); // released, so the resume is a fresh start of a change already started
    const again = start(ws(root), { change: before.change }, quiet);
    expect(again.ok ? "" : again.error.message).toBe(""); // already started: it goes on
    expect(startChore(ws(root), { title: "settle the findings" }, quiet).ok).toBe(true);
    expect(start(ws(root), { title: "fix main" }, quiet, { fixMain: true }).ok).toBe(true);
  });

  test("BR-2464: a change on main not started yet is new work too, and only the first 10 finding numbers are listed", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-5.md"), "---\nid: C-5\ntitle: Waiting\nstatus: open\n---\n\n## 为什么\n\nW.\n\n## 要改什么\n\nX.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "a change waits on main");
    const db = ws(root).db;
    for (let i = 1; i <= 11; i++) db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at) VALUES (?, 'untestable', '[]', '[]', 't', NULL, 1, 'abc', ?)").run(`i-${i}`, new Date().toISOString());
    const r = start(ws(root), { change: "C-5" }, quiet);
    expect(r.ok ? "" : r.error.code).toBe("refused");
    expect(r.ok ? "" : r.error.message).toContain("11 open review finding(s) (#1, #2, #3, #4, #5, #6, #7, #8, #9, #10, …)");
  });

  test("BR-2464: a finding waiting on the owner's verdict is not owed, and neither is a failed review after landing", () => {
    const root = project();
    const db = owe(root);
    db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, asked_at) VALUES (NULL, 'agent:x', 'which way?', '[]', 0, ?)").run(new Date().toISOString());
    const q = Number(db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM questions").get()!.id);
    db.db.query("UPDATE review_findings SET question = ?").run(q);
    expect(start(ws(root), { title: "Free to start" }, quiet).ok).toBe(true);
    // a review that failed (the review command's quota ran out, say) is not owed: it does not hold a start back
    db.db.query("INSERT INTO landed_reviews(entry, change, base, head, landed, log, state, queued_at) VALUES (1, 'C-1', 'a', 'b', 1, 'review.log', 'failed', ?)").run(new Date().toISOString());
    expect(start(ws(root), { title: "Next" }, quiet).ok).toBe(true);
  });
});

describe("handoff length", () => {
  test("BR-2465: --next over 2000 characters is refused and not recorded; status shows only the first line of a long one", () => {
    const root = project();
    const s = startNew(root, "Long");
    const long = stop(ws(s.worktree), "x".repeat(2001), undefined, false);
    expect(long.ok ? "" : `${long.error.code} ${long.error.message}`).toContain("invalid --next is 2001 characters");
    expect(handoffs(ws(root).db)).toEqual([]);
    expect(stop(ws(s.worktree), "y".repeat(2000), undefined, false).ok).toBe(true);
    expect(firstLine("first step\nsecond line")).toBe("first step (canon brief in its worktree shows all of it)");
    expect(firstLine("z".repeat(201))).toBe(`${"z".repeat(200)}… (canon brief in its worktree shows all of it)`);
    expect(firstLine("short")).toBe("short");
  });
});
