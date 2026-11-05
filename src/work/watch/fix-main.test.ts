import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drop } from "../drop/drop.ts";
import { project, quiet, sh, ws } from "../testkit.ts";
import { fixTitle, redMain } from "./redmain.ts";
import { watch } from "./watch.ts";

// reason: each case spawns the CLI, which under load takes seconds per run (C-111)
setDefaultTimeout(90_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const env = { ...process.env, CANON_ACTOR: "agent:a" };

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project in after mode whose main fails its floor, with the failure recorded by a background run. */
async function failingMain() {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nfloor_timing: after\nfloor_quiet_minutes: 0\n");
  writeFileSync(join(root, "FAIL"), "x\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "broken");
  await watch(ws(root), quiet);
  return { root, sha: sh(root, "rev-parse", "main") };
}

const changeBranches = (root: string) => sh(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/").split("\n").filter(Boolean);

describe("canon work start --fix-main", () => {
  test("BR-2221: with a record and no fix change it opens one with the failure in 为什么, records it, and brief names it", async () => {
    const { root, sha } = await failingMain();
    const r = canon(root, "work", "start", "--fix-main");
    expect(r.code).toBe(0);
    const record = redMain(ws(root).db)!;
    expect(record.change).toMatch(/^C-\d+$/);
    const change = record.change!;
    const wt = r.out.match(/^cd (.+)$/m)![1]!;
    const file = readdirSync(join(wt, "canon/changes")).find((f) => f.startsWith(`${change}-`) || f === `${change}.md`)!;
    const text = readFileSync(join(wt, "canon/changes", file), "utf8");
    expect(text).toContain(`title: ${fixTitle(sha)}`);
    expect(fixTitle(sha)).toBe(`修复 main 上没通过的 floor（${sha.slice(0, 9)}）`);
    const why = text.slice(text.indexOf("## 为什么"), text.indexOf("## 要改什么"));
    expect(why).toContain(record.log);
    expect(why).toContain(sha);
    expect(why).toContain("最近通过的提交：无");
    expect(sh(wt, "status", "--porcelain")).toBe("");
    expect(sh(wt, "log", "--format=%s", "-1")).toBe(`canon: open ${change} ${fixTitle(sha)}`);
    const brief = canon(root, "brief").out;
    expect(brief).toContain(`being fixed in ${change}`);
    expect(brief).not.toContain("canon work start --fix-main");
  });

  test("BR-2221: a second --fix-main is a conflict (exit 5) naming the fix change", async () => {
    const { root } = await failingMain();
    expect(canon(root, "work", "start", "--fix-main").code).toBe(0);
    const change = redMain(ws(root).db)!.change!;
    const again = canon(root, "work", "start", "--fix-main");
    expect(again.code).toBe(5);
    expect(again.err).toContain(change);
    expect(changeBranches(root)).toHaveLength(1);
  });

  test("BR-2221: without a record --fix-main is not found (exit 3) and opens nothing", () => {
    const root = project();
    const r = canon(root, "work", "start", "--fix-main");
    expect(r.code).toBe(3);
    expect(changeBranches(root)).toEqual([]);
  });

  test("BR-2221: two sessions running --fix-main at once: one exits 0, the other 5, and only one change is opened", async () => {
    const { root } = await failingMain();
    const procs = [0, 1].map(() => Bun.spawn(["bun", MAIN, "work", "start", "--fix-main"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect([...codes].sort()).toEqual([0, 5]);
    expect(changeBranches(root)).toHaveLength(1);
    expect(redMain(ws(root).db)!.change).toMatch(/^C-\d+$/);
  });

  test("BR-2221: dropping the fix change clears it from the record, and --fix-main opens a new one", async () => {
    const { root } = await failingMain();
    expect(canon(root, "work", "start", "--fix-main").code).toBe(0);
    const first = redMain(ws(root).db)!.change!;
    // The holder lets the change go first, as drop requires (BR-2064).
    const wt = join(`${root}.worktrees`, first);
    expect(canon(wt, "work", "stop", "--next", "dropping it", "--release").code).toBe(0);
    const d = drop(ws(root), first, quiet);
    expect(d.ok ? "dropped" : d.error.message).toBe("dropped");
    expect(redMain(ws(root).db)!.change).toBeNull();
    expect(canon(root, "work", "start", "--fix-main").code).toBe(0);
    const second = redMain(ws(root).db)!.change!;
    expect(second).not.toBe(first);
  });

  test("BR-2221: --fix-main with a change id or --title is a usage error", () => {
    const root = project();
    expect(canon(root, "work", "start", "--fix-main", "--title", "x").code).toBe(2);
    expect(canon(root, "work", "start", "--fix-main", "C-1").code).toBe(2);
  });
});
