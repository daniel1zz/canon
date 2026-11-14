import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { corpusOf } from "../../invocation/command.ts";
import { proposedNotice } from "./proposed.ts";

// Fixture ids are assembled at runtime so this file does not itself name decisions when canon check scans the repo.
const d = (n: number) => ["D", n].join("-");
const decision = (n: number, status: string) => `---\nid: ${d(n)}\ntitle: Pick ${n}\nstatus: ${status}\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;

/** Commits decision n on main as if `hoursAgo` hours before `now`. */
function commitAt(root: string, n: number, status: string, at: number) {
  mkdirSync(join(root, "canon/decisions"), { recursive: true });
  writeFileSync(join(root, `canon/decisions/${d(n)}.md`), decision(n, status));
  sh(root, "add", "-A");
  const date = new Date(at).toISOString();
  Bun.spawnSync(["git", "commit", "-qm", `decision ${n}`], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
}

describe("proposed decisions in the brief", () => {
  test("BR-2476: decisions proposed for more than 24 h are listed oldest first with their age; a newer one, an accepted one and none at all say nothing", () => {
    const root = project();
    const now = Date.now();
    const h = 3_600_000;
    const notice = () => proposedNotice(root, "main", corpusOf(ws(root), "main").corpus, now);
    expect(notice()).toEqual([]);
    commitAt(root, 3, "proposed", now - 23 * h);
    commitAt(root, 4, "accepted", now - 100 * h);
    expect(notice()).toEqual([]);
    commitAt(root, 5, "proposed", now - 25 * h);
    commitAt(root, 6, "proposed", now - 75 * h);
    expect(notice()).toEqual([
      "2 decision(s) proposed for more than 24 h: ask the owner whether to accept each (canon human ask), then canon decision accept <D-n> in a change",
      `  ${d(6)} Pick 6 (3 d)`,
      `  ${d(5)} Pick 5 (1 d)`,
    ]);
  });

  test("BR-2476: exactly 24 h is not listed; the age is whole days rounded down", () => {
    const root = project();
    // reason: git keeps commit times in whole seconds, so now is too, or "exactly 24 h" would be a fraction of a second more
    const now = Math.floor(Date.now() / 1000) * 1000;
    const h = 3_600_000;
    commitAt(root, 7, "proposed", now - 24 * h);
    expect(proposedNotice(root, "main", corpusOf(ws(root), "main").corpus, now)).toEqual([]);
    commitAt(root, 8, "proposed", now - 47 * h);
    expect(proposedNotice(root, "main", corpusOf(ws(root), "main").corpus, now).slice(1)).toEqual([`  ${d(8)} Pick 8 (1 d)`]);
  });

  test("BR-2476: more than 10 are cut after the oldest 10 with how many more", () => {
    const root = project();
    const now = Date.now();
    for (let n = 1; n <= 12; n++) commitAt(root, n, "proposed", now - (100 - n) * 3_600_000);
    const lines = proposedNotice(root, "main", corpusOf(ws(root), "main").corpus, now);
    expect(lines[0]).toStartWith("12 decision(s) proposed for more than 24 h");
    expect(lines[1]).toStartWith(`  ${d(1)} `);
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toBe("  … and 2 more (canon decision list)");
  });
});
