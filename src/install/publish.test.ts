import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "../kernel/result.ts";
import { project, sh } from "../work/testkit.ts";
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
  const publish = (i: number, b = build(`canon v${i + 1}`)) => {
    sh(root, "checkout", "-q", commits[i]!);
    return publishRelease({ primary, cwd: root, green: commits[i]!, build: b });
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
});
