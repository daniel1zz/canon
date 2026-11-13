import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../kernel/result.ts";
import { project, sh, waitFor } from "../work/testkit.ts";
import { publishRelease } from "./publish.ts";

/** A repository with a canon skill at each of three commits, oldest first. */
function history() {
  const root = project();
  const commits: string[] = [];
  for (const v of ["v1", "v2", "v3"]) {
    mkdirSync(join(root, ".claude/skills/canon-a"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/canon-a/SKILL.md"), `a ${v}\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", v);
    commits.push(sh(root, "rev-parse", "HEAD"));
  }
  const primary = project();
  const build = (label: string) => (outfile: string) => {
    writeFileSync(outfile, `${label}\n`);
    return ok(undefined);
  };
  /** Publishes `commit` from a checkout of it. */
  const publish = (i: number, b = build(`canon v${i + 1}`), lockWaitMs?: number) => {
    sh(root, "checkout", "-q", commits[i]!);
    return publishRelease({ primary, cwd: root, green: commits[i]!, build: b, ...(lockWaitMs === undefined ? {} : { lockWaitMs }) });
  };
  return { root, primary, commits, publish };
}

describe("publishing a release (BR-2412)", () => {
  test("BR-2412: the binary and the skills of one commit are published together, the skills behind a link; the release before stays, older ones go", () => {
    const { primary, commits, publish } = history();
    for (const i of [0, 1, 2]) expect(publish(i).ok).toBe(true);
    expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("canon v3\n");
    expect(readlinkSync(join(primary, "dist/skills"))).toBe(`skills-${commits[2]}`);
    expect(readFileSync(join(primary, "dist/skills/canon-a/SKILL.md"), "utf8")).toBe("a v3\n");
    expect(readdirSync(join(primary, "dist")).filter((n) => n.startsWith("skills-")).sort()).toEqual([`skills-${commits[1]}`, `skills-${commits[2]}`].sort());
    expect(readdirSync(join(primary, "dist")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("BR-2412: publishing the same commit again keeps its skills and replaces the binary", () => {
    const { primary, commits, publish } = history();
    expect(publish(2).ok).toBe(true);
    const again = publish(2, (outfile) => {
      writeFileSync(outfile, "canon v3 rebuilt\n");
      return ok(undefined);
    });
    expect(again.ok && again.value.kind).toBe("published");
    expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("canon v3 rebuilt\n");
    expect(readdirSync(join(primary, "dist")).filter((n) => n.startsWith("skills-"))).toEqual([`skills-${commits[2]}`]);
  });

  test("BR-2412: an older commit than the one published replaces nothing", () => {
    const { primary, commits, publish } = history();
    expect(publish(2).ok).toBe(true);
    const older = publish(0);
    expect(older.ok && older.value.kind).toBe("older");
    expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("canon v3\n");
    expect(readlinkSync(join(primary, "dist/skills"))).toBe(`skills-${commits[2]}`);
  });

  test("BR-2412: a failed build publishes nothing and leaves the previous release", () => {
    const { primary, commits, publish } = history();
    expect(publish(0).ok).toBe(true);
    const failed = publish(1, () => err("io", "bun build exited 1"));
    expect(!failed.ok && failed.error.message).toContain("bun build exited 1");
    expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("canon v1\n");
    expect(readlinkSync(join(primary, "dist/skills"))).toBe(`skills-${commits[0]}`);
    expect(existsSync(join(primary, `dist/skills-${commits[1]}`))).toBe(false);
  });

  test("BR-2412: a dist/skills that is a plain directory is refused, nothing replaced", () => {
    const { primary, publish } = history();
    mkdirSync(join(primary, "dist/skills/canon-a"), { recursive: true });
    writeFileSync(join(primary, "dist/skills/canon-a/SKILL.md"), "hand made\n");
    const r = publish(0);
    expect(!r.ok && r.error.message).toContain("is not a symbolic link");
    expect(readFileSync(join(primary, "dist/skills/canon-a/SKILL.md"), "utf8")).toBe("hand made\n");
    expect(existsSync(join(primary, "dist/canon"))).toBe(false);
  });

  test("BR-2412: a slow older build does not replace a newer release published first", async () => {
    const { root, primary, commits } = history();
    const parent = mkdtempSync(join(tmpdir(), "canon-publish-race-"));
    const oldCwd = join(parent, "old");
    const newCwd = join(parent, "new");
    sh(root, "worktree", "add", "-q", oldCwd, commits[0]!);
    sh(root, "worktree", "add", "-q", newCwd, commits[1]!);
    const oldStarted = join(parent, "old-started");
    const newDone = join(parent, "new-done");
    const module = join(import.meta.dir, "publish.ts");
    const oldCode = `
      const { publishRelease } = await import(${JSON.stringify(module)});
      const { writeFileSync, existsSync } = await import("node:fs");
      const r = publishRelease({ primary: process.env.PRIMARY, cwd: process.cwd(), green: process.env.GREEN, build(outfile) {
        writeFileSync(process.env.OLD_STARTED, "started");
        while (!existsSync(process.env.NEW_DONE)) Bun.sleepSync(5);
        writeFileSync(outfile, "old\\n");
        return { ok: true, value: undefined };
      }});
      process.exit(r.ok ? 0 : 1);
    `;
    const newCode = `
      const { publishRelease } = await import(${JSON.stringify(module)});
      const { writeFileSync } = await import("node:fs");
      const r = publishRelease({ primary: process.env.PRIMARY, cwd: process.cwd(), green: process.env.GREEN, build(outfile) {
        writeFileSync(outfile, "new\\n");
        return { ok: true, value: undefined };
      }});
      if (r.ok) writeFileSync(process.env.NEW_DONE, "done");
      process.exit(r.ok ? 0 : 1);
    `;
    const env = (green: string, extra: Record<string, string>) => ({ ...process.env, PRIMARY: primary, GREEN: green, ...extra });
    const old = Bun.spawn(["bun", "-e", oldCode], { cwd: oldCwd, env: env(commits[0]!, { OLD_STARTED: oldStarted, NEW_DONE: newDone }), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    try {
      await waitFor("old release build", () => existsSync(oldStarted));
      const newer = Bun.spawn(["bun", "-e", newCode], { cwd: newCwd, env: env(commits[1]!, { NEW_DONE: newDone }), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      expect(await newer.exited).toBe(0);
      expect(await old.exited).toBe(0);
      expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("new\n");
      expect(readlinkSync(join(primary, "dist/skills"))).toBe(`skills-${commits[1]}`);
      expect(existsSync(join(primary, `dist/skills-${commits[0]}`))).toBe(false);
    } finally {
      if (old.exitCode === null) old.kill();
      sh(root, "worktree", "remove", "-f", oldCwd);
      sh(root, "worktree", "remove", "-f", newCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("BR-2412: a publish lock timeout is an environment error and succeeds after the holder releases", async () => {
    const { primary, commits, publish } = history();
    expect(publish(0).ok).toBe(true);
    const common = sh(primary, "rev-parse", "--git-common-dir");
    const lock = join(common, "canon/publish.lock");
    const parent = mkdtempSync(join(tmpdir(), "canon-publish-lock-"));
    const held = join(parent, "held");
    const holderCode = `
      const { Database } = await import("bun:sqlite");
      const { writeFileSync } = await import("node:fs");
      const db = new Database(process.env.LOCK);
      db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      writeFileSync(process.env.HELD, "held");
      await Bun.sleep(500);
      db.exec("ROLLBACK;");
      db.close();
    `;
    const holder = Bun.spawn(["bun", "-e", holderCode], { cwd: primary, env: { ...process.env, LOCK: lock, HELD: held }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    try {
      await waitFor("publish lock holder", () => existsSync(held));
      const blocked = publish(1, (outfile) => {
        writeFileSync(outfile, "new\n");
        return ok(undefined);
      }, 50);
      expect(!blocked.ok && blocked.error.code).toBe("io");
      expect(!blocked.ok && blocked.error.message).toContain("publish lock");
      expect(readFileSync(join(primary, "dist/canon"), "utf8")).toBe("canon v1\n");
      expect(readlinkSync(join(primary, "dist/skills"))).toBe(`skills-${commits[0]}`);
      expect(await holder.exited).toBe(0);
      expect(publish(1).ok).toBe(true);
    } finally {
      if (holder.exitCode === null) holder.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
