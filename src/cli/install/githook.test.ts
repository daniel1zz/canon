import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureGuard, GUARD_HEADER, guardScript } from "./githook.ts";

// reason: every test here drives the canon CLI through spawned processes, which is what it tests; each spawn is a bun start
// plus the command's own git calls, and at load 20 one test took 4.2 s of the 5 s default (C-111).
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "main.ts");

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-guard-src-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const ENV = { CANON_SKILLS_SOURCE: dir({ "canon-a/SKILL.md": "a v1\n" }) };

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test", ...ENV } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}
const sh = (cwd: string, ...args: string[]) => git(cwd, args).out;

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-guard-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(root, ...args);
  writeFileSync(join(root, "app.txt"), "one\n");
  sh(root, "add", "-A");
  expect(git(root, ["commit", "-qm", "first"]).code).toBe(0); // the repository's first commit: main does not exist yet
  return root;
}

/** A repository with canon on main and the guard installed. */
function adopted(): string {
  const root = repo();
  expect(canon(root, "init", "--floor", "true").code).toBe(0);
  sh(root, "add", "-A");
  expect(git(root, ["commit", "-qm", "adopt canon"]).code).toBe(0); // canon is not on main yet: allowed
  return root;
}

const hookPath = (root: string) => join(root, ".git/hooks/reference-transaction");

describe("installing the guard", () => {
  test("BR-2123: init writes an executable, marked hook into the hooks directory, core.hooksPath included; update finds and restores it in place", () => {
    const root = adopted();
    const path = hookPath(root);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(readFileSync(path, "utf8").split("\n")[1]).toBe(GUARD_HEADER);
    expect(canon(root, "update", "--check").code).toBe(0);

    unlinkSync(path);
    const missing = canon(root, "update", "--check");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("git hook: main moves only through canon work land");
    const before = sh(root, "rev-parse", "main");
    const updated = canon(root, "update");
    expect(updated.code).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(sh(root, "rev-parse", "main")).toBe(before); // nothing to land: the hook is not in the tree

    writeFileSync(path, `#!/bin/sh\n${GUARD_HEADER}\nexit 0\n`);
    const old = canon(root, "update", "--check");
    expect(old.code).toBe(1);
    expect(old.out).toContain("older form");
    expect(canon(root, "install").code).toBe(0);
    expect(readFileSync(path, "utf8")).not.toContain("\nexit 0\n");
    expect(readdirSync(join(root, ".git/hooks")).filter((f) => f.includes(".tmp"))).toEqual([]); // replaced by rename, nothing left over
    expect(canon(root, "update", "--check").code).toBe(0);

    const other = repo();
    sh(other, "config", "core.hooksPath", ".githooks");
    expect(canon(other, "install").code).toBe(0);
    expect(existsSync(join(other, ".githooks/reference-transaction"))).toBe(true);
    expect(existsSync(hookPath(other))).toBe(false);
  });

  test("BR-2124 BR-2022: someone else's reference-transaction hook is never overwritten: install refuses with 5 before writing anything, even with --force; --check lists it", () => {
    const root = repo();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hookPath(root), "#!/bin/sh\nexit 0\n");
    for (const args of [["install"], ["install", "--force"]]) {
      const r = canon(root, ...args);
      expect(r.code).toBe(5);
      expect(r.err).toContain(hookPath(root));
    }
    expect(readFileSync(hookPath(root), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(existsSync(join(root, ".claude/skills"))).toBe(false);
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    symlinkSync(tmpdir(), join(root, ".claude/skills/canon-a")); // BR-2083 would refuse with 2; the foreign hook is checked first
    expect(canon(root, "install").code).toBe(5);
    rmSync(join(root, ".claude"), { recursive: true });
    const init = canon(root, "init", "--floor", "true");
    expect(init.code).toBe(5);
    expect(existsSync(join(root, "canon"))).toBe(false);

    const ours = adopted();
    writeFileSync(hookPath(ours), "#!/bin/sh\nexit 0\n");
    const check = canon(ours, "update", "--check");
    expect(check.code).toBe(1);
    expect(check.out).toContain("not written by canon");
    expect(canon(ours, "update").code).toBe(5);
  });

  const FOREIGN = "#!/bin/sh\nexit 0\n";
  const leftovers = (root: string) => readdirSync(join(root, ".git/hooks")).filter((f) => f.includes(".canon-"));

  test("BR-2124: a hook someone else writes after canon read the state, while it is missing, is kept and the install refuses with conflict", () => {
    const root = repo();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    const r = ensureGuard(root, "main", () => writeFileSync(hookPath(root), FOREIGN));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("conflict");
      expect(r.error.message).toContain(hookPath(root));
    }
    expect(readFileSync(hookPath(root), "utf8")).toBe(FOREIGN);
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124: canon's older guard swapped for someone else's hook after canon read it is put back, not replaced, and the install refuses with conflict", () => {
    const root = repo();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hookPath(root), `#!/bin/sh\n${GUARD_HEADER}\nexit 0\n`, { mode: 0o755 });
    const r = ensureGuard(root, "main", () => writeFileSync(hookPath(root), FOREIGN));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    expect(readFileSync(hookPath(root), "utf8")).toBe(FOREIGN);
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124: the current guard written by another canon in between counts as done; with nobody in between the guard is installed", () => {
    const root = repo();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    const other = ensureGuard(root, "main", () => writeFileSync(hookPath(root), guardScript("main"), { mode: 0o755 }));
    expect(other).toEqual({ ok: true, value: false });
    expect(readFileSync(hookPath(root), "utf8")).toBe(guardScript("main"));

    writeFileSync(hookPath(root), `#!/bin/sh\n${GUARD_HEADER}\nexit 0\n`, { mode: 0o755 });
    expect(ensureGuard(root, "main", () => {})).toEqual({ ok: true, value: true });
    expect(readFileSync(hookPath(root), "utf8")).toBe(guardScript("main"));
    expect(statSync(hookPath(root)).mode & 0o111).not.toBe(0);
    expect(leftovers(root)).toEqual([]);
  });
});

describe("installing the guard while someone else writes the hook", () => {
  const FOREIGN = "#!/bin/sh\nexit 0\n";
  const OLD = `#!/bin/sh\n${GUARD_HEADER}\nexit 0\n`;
  const realLink = fs.linkSync;
  const leftovers = (root: string) => readdirSync(join(root, ".git/hooks")).filter((f) => f.includes(".canon-"));

  /** A repository whose hooks directory holds `hook` (or nothing). */
  function withHook(hook?: string): string {
    const root = repo();
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    if (hook !== undefined) writeFileSync(hookPath(root), hook, { mode: 0o755 });
    return root;
  }

  /** Runs ensureGuard with linkSync replaced by `link`, restoring it afterwards. */
  function guarded(root: string, link: (from: string, to: string) => void, beforeReplace?: () => void) {
    const spy = spyOn(fs, "linkSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => link(String(from), String(to))) as typeof fs.linkSync);
    try {
      return ensureGuard(root, "main", beforeReplace);
    } finally {
      spy.mockRestore();
    }
  }

  const noHardLinks = () => {
    throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
  };

  test("BR-2124: someone else's hook moved aside is kept beside the path when the path is taken again before it can go back", () => {
    const root = withHook(OLD);
    const r = guarded(
      root,
      (from, to) => {
        if (from.endsWith(".old")) writeFileSync(to, "#!/bin/sh\necho B\n");
        realLink(from, to);
      },
      () => writeFileSync(hookPath(root), FOREIGN),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.error.code, r.error.message]).toEqual(["conflict", expect.stringContaining(`${hookPath(root)}.canon-`)]);
    expect(readFileSync(hookPath(root), "utf8")).toBe("#!/bin/sh\necho B\n");
    const kept = leftovers(root);
    expect(kept.length).toBe(1);
    expect(readFileSync(join(root, ".git/hooks", kept[0]!), "utf8")).toBe(FOREIGN);
  });

  test("BR-2124: a hook written on the empty path after canon moved its older guard aside is kept, the older guard deleted, conflict", () => {
    const root = withHook(OLD);
    const r = guarded(root, (from, to) => {
      if (from.endsWith(".tmp")) writeFileSync(to, FOREIGN);
      realLink(from, to);
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    expect(readFileSync(hookPath(root), "utf8")).toBe(FOREIGN);
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124: the current guard put on the path by another canon after the older one was moved aside counts as done", () => {
    const root = withHook(OLD);
    const r = guarded(root, (from, to) => {
      if (from.endsWith(".tmp")) writeFileSync(to, guardScript("main"), { mode: 0o755 });
      realLink(from, to);
    });
    expect(r).toEqual({ ok: true, value: false });
    expect(readFileSync(hookPath(root), "utf8")).toBe(guardScript("main"));
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124 BR-2022: a hooks directory without hard links stops the install of a missing guard with an environment error, nothing left over", () => {
    const root = withHook();
    const r = guarded(root, noHardLinks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.error.code, r.error.message]).toEqual(["io", expect.stringContaining("hard links")]);
    expect(existsSync(hookPath(root))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124 BR-2022: without hard links, a hook written on the empty path while the older guard is aside is kept, the older guard left beside it", () => {
    const root = withHook(OLD);
    const r = guarded(root, (from, to) => {
      if (from.endsWith(".tmp")) writeFileSync(to, FOREIGN);
      noHardLinks();
    });
    expect(r.ok).toBe(false);
    const kept = leftovers(root);
    if (!r.ok) expect([r.error.code, r.error.message]).toEqual(["io", expect.stringContaining(kept[0] ?? "<nothing kept>")]);
    expect(readFileSync(hookPath(root), "utf8")).toBe(FOREIGN);
    expect(kept.length).toBe(1);
    expect(readFileSync(join(root, ".git/hooks", kept[0]!), "utf8")).toBe(OLD);
  });

  const ioError = () => {
    throw Object.assign(new Error("EIO: i/o error, link"), { code: "EIO" });
  };

  test("BR-2124 BR-2022: when only placing the new guard fails, the older guard goes back by the same exclusive link, nothing left over", () => {
    const root = withHook(OLD);
    const r = guarded(root, (from, to) => (from.endsWith(".tmp") ? ioError() : realLink(from, to)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("io");
    expect(readFileSync(hookPath(root), "utf8")).toBe(OLD);
    expect(leftovers(root)).toEqual([]);
  });

  test("BR-2124 BR-2022: when placing the new guard fails and a hook appears on the empty path, that hook stays and the older guard is deleted", () => {
    const root = withHook(OLD);
    const r = guarded(root, (from, to) => {
      if (!from.endsWith(".tmp")) return realLink(from, to);
      writeFileSync(to, FOREIGN);
      ioError();
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("io");
    expect(readFileSync(hookPath(root), "utf8")).toBe(FOREIGN);
    expect(leftovers(root)).toEqual([]);
  });
});

describe("the main branch name in the guard", () => {
  /** A repository on branch `main` (any name git accepts) with canon adopted and that name in canon/config.yaml. */
  function adoptedOn(main: string): string {
    const root = mkdtempSync(join(tmpdir(), "canon-guard-"));
    for (const args of [["init", "-q", "-b", main], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(root, ...args);
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon/config.yaml"), `main: ${JSON.stringify(main)}\nfloor: "true"\n`);
    expect(canon(root, "install").code).toBe(0);
    sh(root, "add", "-A");
    expect(git(root, ["commit", "-qm", "adopt canon"]).code).toBe(0); // the first commit: the branch does not exist yet
    return root;
  }

  test("BR-2123: the guard takes main from canon/config.yaml, any name git accepts included, and guards only that branch", () => {
    for (const main of ["trunk", "rel+1", 'a$b"`c']) {
      const root = adoptedOn(main);
      expect(canon(root, "update", "--check").code).toBe(0);
      writeFileSync(join(root, "app.txt"), "two\n");
      sh(root, "add", "app.txt");
      const commit = git(root, ["commit", "-qm", "direct"]);
      expect(commit.code).not.toBe(0);
      expect(commit.err).toContain(`canon: refusing to move ${main}:`);
      sh(root, "checkout", "-qb", "main");
      expect(git(root, ["commit", "-qm", "on a branch named main"]).code).toBe(0); // main is just another branch here
    }
  });

  test("BR-2123 BR-2045: a main git would refuse as a branch name is a config error, exit 2 before anything is written", () => {
    const root = repo();
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon/config.yaml"), 'main: "a..b"\nfloor: "true"\n');
    for (const args of [["install"], ["update", "--check"]]) {
      const r = canon(root, ...args);
      expect([r.code, r.err]).toEqual([2, expect.stringContaining('"a..b" is not a valid git branch name')]);
    }
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(hookPath(root))).toBe(false);
  });

  test("BR-2123 BR-2124: a main git would refuse and someone else's hook together: the branch name is reported first, exit 2, the hook kept", () => {
    const root = repo();
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon/config.yaml"), 'main: "a..b"\nfloor: "true"\n');
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hookPath(root), "#!/bin/sh\nexit 0\n");
    for (const args of [["install"], ["update"], ["update", "--check"]]) {
      const r = canon(root, ...args);
      expect([r.code, r.err]).toEqual([2, expect.stringContaining('"a..b" is not a valid git branch name')]);
    }
    expect(readFileSync(hookPath(root), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });
});

describe("what the guard refuses", () => {
  test("BR-2126: once canon is on main, commit, merge, update-ref and push onto main are refused and main stays", () => {
    const root = adopted();
    const main = sh(root, "rev-parse", "main");
    writeFileSync(join(root, "app.txt"), "two\n");
    const commit = git(root, ["commit", "-qam", "direct"]);
    expect(commit.code).not.toBe(0);
    expect(commit.err).toContain("canon: refusing to move main");
    expect(commit.err).toContain("canon work land");
    sh(root, "reset", "-q", "--hard");
    sh(root, "checkout", "-qb", "x");
    writeFileSync(join(root, "x.txt"), "x\n");
    sh(root, "add", "x.txt");
    sh(root, "commit", "-qm", "x");
    const x = sh(root, "rev-parse", "x");
    sh(root, "checkout", "-q", "main");
    expect(git(root, ["merge", "-q", "--no-ff", "-m", "m", "x"]).code).not.toBe(0);
    git(root, ["merge", "--abort"]);
    sh(root, "reset", "-q", "--hard");
    expect(git(root, ["update-ref", "refs/heads/main", x]).code).not.toBe(0);
    sh(root, "checkout", "-q", "--detach");
    expect(git(root, ["push", "-q", ".", "x:main"]).code).not.toBe(0);
    expect(git(root, ["update-ref", "refs/heads/main", x], { CANON_LAND_MAIN: main }).code).not.toBe(0); // marker names another commit
    expect(sh(root, "rev-parse", "main")).toBe(main);
    expect(git(root, ["update-ref", "refs/heads/main", x], { CANON_LAND_MAIN: x }).code).toBe(0);
    expect(sh(root, "rev-parse", "main")).toBe(x);
  });

  test("BR-2126: no-op rows, pack-refs, other branches and commits before canon is on main pass", () => {
    const root = adopted();
    expect(git(root, ["reset", "-q", "HEAD"]).code).toBe(0);
    expect(git(root, ["pack-refs", "--all"]).code).toBe(0);
    expect(git(root, ["branch", "y"]).code).toBe(0);
    writeFileSync(join(root, "y.txt"), "y\n");
    sh(root, "checkout", "-q", "y");
    sh(root, "add", "y.txt");
    expect(git(root, ["commit", "-qm", "y"]).code).toBe(0);
    sh(root, "checkout", "-q", "main");
    expect(git(root, ["branch", "-D", "y"]).code).toBe(0);
    // repo() and adopted() already committed on main twice before canon/config.yaml was on it
    expect(sh(root, "log", "--format=%s", "main")).toBe("adopt canon\nfirst");
  });
});
