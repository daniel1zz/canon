import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land/land.ts";
import { renderAfterLandAll, waitAfterLand } from "../hooks/after-land.ts";
import { FAST, project, quiet, startNew, ws } from "../testkit.ts";
import { CLEAN_AFTER_LAND_ENV, cleanAfterLanding } from "./clean-after-land.ts";

async function landed(root: string, title: string) {
  const s = startNew(root, title);
  const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
  if (out.kind !== "landed") throw new Error(`expected landed, got ${out.kind}`);
  return s;
}

/** A process whose current directory is `dir`, as a landing's shell would be. */
const sitIn = (dir: string, seconds: number) => Bun.spawn(["sleep", String(seconds)], { cwd: dir, stdout: "ignore", stderr: "ignore", stdin: "ignore" });

const subjectOf = (worktree: string) => worktree.split("/").pop()!;

describe("the landed worktree removed after land --finish (BR-2486)", () => {
  test("BR-2486, BR-2167: land --finish says the worktree is removed in the background, and canon work after-land --wait waits for the removal and reports it removed", async () => {
    const root = project();
    const s = startNew(root, "Removed after landing");
    const said: string[] = [];
    process.env[CLEAN_AFTER_LAND_ENV] = "1";
    let out: Awaited<ReturnType<typeof land>>;
    try {
      out = await land(ws(s.worktree), { ...FAST, finish: true }, (l) => said.push(l));
    } finally {
      process.env[CLEAN_AFTER_LAND_ENV] = "0";
    }
    expect(out.kind).toBe("landed");
    const subject = subjectOf(s.worktree);
    expect(said.join("\n")).toContain(`${subject}'s worktree is removed in the background once nothing runs inside it`);
    expect(said.join("\n")).not.toContain("once you have left it");
    // with no change named, after-land finds the latest removal (BR-2486)
    const r = await waitAfterLand(ws(root), undefined, 25_000, 200);
    expect(r.clean?.done).toBe(true);
    const text = renderAfterLandAll(r);
    expect(text).toContain("removal of the landed worktree");
    expect(text).toContain(`removed ${s.worktree}`);
    expect(existsSync(s.worktree)).toBe(false);
  });

  test.skipIf(process.platform === "linux")("BR-2486: a process still inside is waited for; once it exits the worktree is removed", async () => {
    const root = project();
    const s = await landed(root, "Shell inside");
    const p = sitIn(s.worktree, 1);
    const said: string[] = [];
    const r = await cleanAfterLanding(ws(root), (l) => said.push(l), subjectOf(s.worktree), [500, 1000, 2000, 4000]);
    await p.exited;
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([s.worktree]);
    expect(said).toEqual([`removed ${s.worktree}`]);
  });

  test.skipIf(process.platform === "linux")("BR-2486: a process that stays inside past the last try keeps the worktree, saying so and how to remove it later", async () => {
    const root = project();
    const s = await landed(root, "Shell stays");
    const p = sitIn(s.worktree, 20);
    try {
      const said: string[] = [];
      const r = await cleanAfterLanding(ws(root), (l) => said.push(l), subjectOf(s.worktree), [50, 50]);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.removed).toEqual([]);
      expect(said.join("\n")).toContain(`kept ${s.worktree}: in use by`);
      expect(said.join("\n")).toContain(`run canon work clean ${subjectOf(s.worktree)} once you have left it`);
      expect(existsSync(s.worktree)).toBe(true);
    } finally {
      p.kill();
    }
  });

  test("BR-2486: a worktree kept for another reason than a process is kept at once, with that reason", async () => {
    const root = project();
    const s = await landed(root, "Left a file");
    writeFileSync(join(s.worktree, "draft.txt"), "x\n");
    const said: string[] = [];
    const started = Date.now();
    const r = await cleanAfterLanding(ws(root), (l) => said.push(l), subjectOf(s.worktree), [60_000]);
    if (!r.ok) throw new Error(r.error.message);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(said).toEqual([`kept ${s.worktree}: uncommitted changes`]);
  });
});
