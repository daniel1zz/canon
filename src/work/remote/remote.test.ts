import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { land } from "../land/land.ts";
import { ensureGuard } from "../../install/githook.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { HANG_SECONDS, FAST, project, quiet, sh, startNew, waitFor, waitGone, ws } from "../testkit.ts";
import { pushMain } from "./remote.ts";

setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project with a local bare repository as `origin` (never the network), main's config naming `remote` when given. */
function withRemote(config: string): { root: string; bare: string } {
  const root = project();
  const bare = mkdtempSync(join(tmpdir(), "canon-remote-"));
  sh(bare, "init", "-q", "--bare");
  sh(root, "remote", "add", "origin", bare);
  writeFileSync(join(root, "canon/config.yaml"), `${/^floor:/m.test(config) ? "" : "floor: test ! -e FAIL\n"}tests: []\n${config}`);
  sh(root, "commit", "-q", "--allow-empty", "-am", "config");
  return { root, bare };
}

/** Pushes local main to the bare repository by hand, as the starting state. */
const seed = (root: string) => sh(root, "push", "-q", "origin", "main");

/** A commit made on the remote's main from another clone; returns its sha. */
function remoteCommit(bare: string, file: string): string {
  const clone = mkdtempSync(join(tmpdir(), "canon-clone-"));
  sh(clone, "clone", "-q", bare, ".");
  sh(clone, "config", "user.email", "t@t");
  sh(clone, "config", "user.name", "t");
  writeFileSync(join(clone, file), `${file}\n`);
  sh(clone, "add", file);
  sh(clone, "commit", "-qm", file);
  sh(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
  return sh(clone, "rev-parse", "HEAD");
}

const commitOnMain = (root: string, file: string) => {
  writeFileSync(join(root, file), `${file}\n`);
  sh(root, "add", file);
  sh(root, "commit", "-qm", file);
};

const commitFile = (wt: string, file: string) => {
  writeFileSync(join(wt, file), `${file}\n`);
  sh(wt, "add", file);
  sh(wt, "commit", "-qm", file);
};

const events = (root: string, kind: string) =>
  ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail) as Record<string, unknown>);

/** A script that starts `sleep` in the background, writes the sleep's pid to `pidFile` and waits for it. */
const sleeperScript = (pidFile: string) => `#!/bin/sh\nsleep ${HANG_SECONDS} &\necho $! > ${pidFile}\nwait\n`;

/** The pid a sleeper script wrote; fails loudly when it never started. */
async function sleeperPid(pidFile: string): Promise<number> {
  await waitFor("the sleeper to write its pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  return Number(readFileSync(pidFile, "utf8").trim());
}

const bareMain = (bare: string) => sh(bare, "rev-parse", "refs/heads/main");

describe("push after landing", () => {
  test("BR-2259: a landing pushes main's new commit to the remote's main only: no tags, no other branch; the tracking ref follows and push.ok is recorded", async () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    sh(root, "tag", "v1");
    sh(root, "branch", "other");
    const s = startNew(root, "Pushed");
    commitFile(s.worktree, "a.txt");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    const main = sh(root, "rev-parse", "main");
    expect(bareMain(bare)).toBe(main);
    expect(sh(root, "rev-parse", "refs/remotes/origin/main")).toBe(main);
    expect(sh(bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(events(root, "push.ok").at(-1)).toMatchObject({ remote: "origin", sha: main });
    expect(events(root, "push.fail")).toEqual([]);
    expect(said.some((m) => m.startsWith(`pushed ${main.slice(0, 9)} to origin`))).toBe(true);
  });

  test("BR-2259: without `remote` nothing is pushed and no push event is written", async () => {
    const { root, bare } = withRemote("");
    seed(root);
    const before = bareMain(bare);
    const s = startNew(root, "Not pushed");
    commitFile(s.worktree, "a.txt");
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (m) => said.push(m))).kind).toBe("landed");
    expect(bareMain(bare)).toBe(before);
    expect(events(root, "push.ok")).toEqual([]);
    expect(events(root, "push.fail")).toEqual([]);
    expect(said.some((m) => m.includes("push"))).toBe(false);
  });

  test("BR-2259: with floor_timing after the landing pushes without waiting for the background floor", async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "canon-fake-bin-"));
    writeFileSync(join(fakeBin, "canon"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, "canon"), 0o755);
    const path = process.env["PATH"];
    // reason: an after-mode landing asks PATH's canon to read the config (BR-2224); a stub keeps the test off the machine's canon
    process.env["PATH"] = `${fakeBin}:${path}`;
    try {
      const { root, bare } = withRemote("remote: origin\nfloor_timing: after\nfloor_quiet_minutes: 0\nfloor: exit 1\n");
      seed(root);
      const s = startNew(root, "After");
      commitFile(s.worktree, "a.txt");
      expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
      expect(bareMain(bare)).toBe(sh(root, "rev-parse", "main"));
    } finally {
      process.env["PATH"] = path;
    }
  });

  test("BR-2259: a push that arrives after a newer one is refused by the remote but counts as pushed: the remote already has the commit", () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    const a = sh(root, "rev-parse", "main");
    const b = remoteCommit(bare, "b.txt"); // a newer push of a descendant of a got there first
    const r = pushMain(ws(root), quiet);
    expect(r).toEqual({ ok: true, sha: a });
    expect(bareMain(bare)).toBe(b);
    expect(events(root, "push.ok").at(-1)).toMatchObject({ sha: a, already: true });
    expect(events(root, "push.fail")).toEqual([]);
  });

  test("BR-2259: a refused landing pushes nothing", async () => {
    const { root } = withRemote("remote: origin\n");
    seed(root);
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("dirty");
    expect(events(root, "push.ok")).toEqual([]);
    expect(events(root, "push.fail")).toEqual([]);
  });
});

describe("a failed push", () => {
  test("BR-2260: the remote has a commit main lacks: the landing still lands and finishes, the remote keeps its main, push.fail carries git's rejection", async () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    const x = remoteCommit(bare, "x.txt");
    const s = startNew(root, "Rejected");
    commitFile(s.worktree, "a.txt");
    const said: string[] = [];
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    expect(out.kind === "landed" && out.finished).toBe(true);
    expect(sh(root, "rev-parse", "main")).toBe(sh(s.worktree, "rev-parse", "HEAD"));
    const change = readCorpus(root, ws(root).config.types, ws(root).config).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("done");
    expect(bareMain(bare)).toBe(x);
    const fail = events(root, "push.fail").at(-1)!;
    expect(fail["remote"]).toBe("origin");
    expect(String(fail["reason"])).toContain("rejected");
    expect(said.some((m) => m.startsWith("push to origin failed"))).toBe(true);
    expect(events(root, "push.ok")).toEqual([]);
  });

  test("BR-2260: a remote name git does not know fails the push, not the landing", async () => {
    const { root } = withRemote("remote: nowhere\n");
    const s = startNew(root, "Nowhere");
    commitFile(s.worktree, "a.txt");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    expect(String(events(root, "push.fail").at(-1)!["reason"])).toContain("nowhere");
  });

  test("BR-2260: a push slower than remote_timeout_seconds is stopped with what git started (the hook's child, git-receive-pack) and recorded with how long it waited", async () => {
    const { root, bare } = withRemote("remote: origin\nremote_timeout_seconds: 1\n");
    seed(root);
    const before = bareMain(bare);
    const hook = join(sh(root, "rev-parse", "--absolute-git-dir"), "hooks", "pre-push");
    const pidFile = join(sh(root, "rev-parse", "--absolute-git-dir"), "hook-child.pid");
    writeFileSync(hook, sleeperScript(pidFile));
    chmodSync(hook, 0o755);
    const s = startNew(root, "Slow");
    commitFile(s.worktree, "a.txt");
    const t = Date.now();
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(String(events(root, "push.fail").at(-1)!["reason"])).toContain("1 s");
    expect(bareMain(bare)).toBe(before);
    const child = await sleeperPid(pidFile);
    try {
      await waitGone(child, "the pre-push hook's child");
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // reason: already gone, which is what the assertion above wants
      }
    }
  });

  test("BR-2259, BR-2260: a failed push and the fetch after it together wait at most remote_timeout_seconds, not twice that, and the stalled fetch's processes are stopped", async () => {
    const { root, bare } = withRemote("remote: origin\nremote_timeout_seconds: 10\n");
    seed(root);
    const gitDir = sh(root, "rev-parse", "--absolute-git-dir");
    // The push fails after 4 s; the fetch that follows would hang (a remote that answers nothing).
    const hook = join(gitDir, "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nsleep 4\nexit 1\n");
    chmodSync(hook, 0o755);
    const stall = join(gitDir, "stall.sh");
    const pidFile = join(gitDir, "stall-child.pid");
    writeFileSync(stall, sleeperScript(pidFile));
    chmodSync(stall, 0o755);
    sh(root, "config", "remote.origin.uploadpack", stall);
    const before = bareMain(bare);
    const t = Date.now();
    const r = pushMain(ws(root), quiet);
    expect(Date.now() - t).toBeLessThan(12_500);
    expect(r?.ok).toBe(false);
    expect(events(root, "push.fail")).toHaveLength(1);
    expect(String(events(root, "push.fail")[0]!["reason"])).not.toContain("was stopped");
    expect(bareMain(bare)).toBe(before);
    const child = await sleeperPid(pidFile);
    try {
      await waitGone(child, "the stalled upload-pack's child");
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // reason: already gone, which is what the assertion above wants
      }
    }
  });
});

describe("canon brief and unpushed commits", () => {
  test("BR-2261: brief counts main's commits the tracking ref lacks, with the last failed push's reason, and says nothing once they are pushed", () => {
    const { root } = withRemote("remote: origin\n");
    seed(root);
    for (const f of ["a.txt", "b.txt", "c.txt"]) commitOnMain(root, f);
    let r = canon(root, "brief");
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 commit(s) on main not pushed to origin");
    expect(r.out).not.toContain("last push failed");
    ws(root).db.event("agent:a", "push.fail", null, { remote: "origin", sha: null, reason: "!\tabc:refs/heads/main\t[rejected] (fetch first)\nerror: failed to push" });
    r = canon(root, "brief");
    expect(r.out).toContain("3 commit(s) on main not pushed to origin (last push failed: !\tabc:refs/heads/main\t[rejected] (fetch first))");
    ws(root).db.event("agent:a", "push.ok", null, { remote: "origin", sha: "x" });
    r = canon(root, "brief");
    expect(r.out).toContain("3 commit(s) on main not pushed to origin;");
    expect(r.out).not.toContain("[rejected]");
    seed(root);
    expect(canon(root, "brief").out).not.toContain("not pushed");
  });

  test("BR-2261: with no tracking ref yet every commit of main counts; without `remote` or in a claimed worktree there is no line", () => {
    const { root } = withRemote("remote: origin\n");
    const all = sh(root, "rev-list", "--count", "main");
    expect(canon(root, "brief").out).toContain(`${all} commit(s) on main not pushed to origin`);
    const s = startNew(root, "Claimed");
    expect(canon(s.worktree, "brief").out).not.toContain("not pushed");
    const none = withRemote("");
    expect(canon(none.root, "brief").out).not.toContain("not pushed");
  });
});

describe("canon sync", () => {
  test("BR-2262: fast-forwards main to the remote's newer main through canon's git guard, the checked-out files follow, sync.ok is recorded", () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    expect(ensureGuard(root, "main")).toEqual({ ok: true, value: true });
    const r = remoteCommit(bare, "r.txt");
    const out = canon(root, "sync");
    expect(out.code).toBe(0);
    expect(sh(root, "rev-parse", "main")).toBe(r);
    expect(existsSync(join(root, "r.txt"))).toBe(true);
    expect(events(root, "sync.ok").at(-1)).toMatchObject({ remote: "origin", to: r });
    expect(out.out).toContain("fast-forwarded main");
  });

  test("BR-2262: equal mains move nothing; a local main ahead of the remote moves nothing and says by how many commits", () => {
    const { root } = withRemote("remote: origin\n");
    seed(root);
    let out = canon(root, "sync");
    expect(out.code).toBe(0);
    expect(out.out).toContain("already up to date");
    expect(events(root, "sync.ok")).toEqual([]);
    commitOnMain(root, "a.txt");
    commitOnMain(root, "b.txt");
    const before = sh(root, "rev-parse", "main");
    out = canon(root, "sync");
    expect(out.code).toBe(0);
    expect(out.out).toContain("2 commit(s) ahead of origin");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2262 BR-2022: a checked-out main with uncommitted changes exits 1 and moves nothing; no `remote` exits 2; a remote that cannot be fetched exits 4", () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    remoteCommit(bare, "r.txt");
    const before = sh(root, "rev-parse", "main");
    writeFileSync(join(root, "app.txt"), "edited\n");
    const dirty = canon(root, "sync");
    expect(dirty.code).toBe(1);
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "sync.refuse").at(-1)!["reason"]).toBe("main-dirty");

    const none = withRemote("");
    expect(canon(none.root, "sync").code).toBe(2);

    const lost = withRemote("remote: nowhere\n");
    const at = sh(lost.root, "rev-parse", "main");
    expect(canon(lost.root, "sync").code).toBe(4);
    expect(sh(lost.root, "rev-parse", "main")).toBe(at);
    expect(events(lost.root, "sync.refuse").at(-1)!["reason"]).toBe("fetch");
  });

  test("BR-2263 BR-2022: diverged mains exit 5: no merge, main and the files stay, sync.refuse says diverged", () => {
    const { root, bare } = withRemote("remote: origin\n");
    seed(root);
    remoteCommit(bare, "r.txt");
    commitOnMain(root, "l.txt");
    const l = sh(root, "rev-parse", "main");
    const out = canon(root, "sync");
    expect(out.code).toBe(5);
    expect(out.err).toContain("diverged");
    expect(out.err).toContain("1 commit(s)");
    expect(sh(root, "rev-parse", "main")).toBe(l);
    expect(sh(root, "rev-list", "--count", "--merges", "main")).toBe("0");
    expect(existsSync(join(root, "r.txt"))).toBe(false);
    expect(events(root, "sync.refuse").at(-1)).toMatchObject({ reason: "diverged", local: l });
  });
});
