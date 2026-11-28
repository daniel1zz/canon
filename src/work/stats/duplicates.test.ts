import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, ws } from "../testkit.ts";

// reason: each case spawns canon; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const change = (n: number, status = "open") => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: []\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;

function repo(changes: Record<number, string>): string {
  const root = project();
  for (const [n, status] of Object.entries(changes)) {
    const p = join(root, `canon/changes/C-${n}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, change(Number(n), status));
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const remind = (root: string, a: string, b: string, stage: string) => ws(root).db.event("agent:a", "duplicate.remind", a, { stage, with: b });
const answer = (root: string, a: string, b: string, same: boolean) => ws(root).db.event("agent:a", "duplicate.answer", a, { with: b, same, reason: same ? null : "different" });
const section = (out: string) => out.split("\n").filter((l) => l === "Duplicate reminders" || /^  (new|land): reminded/.test(l));

describe("BR-2659: canon stats gives the duplicate reminder's precision per stage", () => {
  test("BR-2659: reminded pairs, latest answers, unanswered, precision and pairs with a side dropped", () => {
    const root = repo({ 1: "open", 2: "open", 3: "open", 4: "open", 5: "dropped", 6: "open", 7: "open" });
    remind(root, "C-1", "C-2", "new");
    remind(root, "C-1", "C-2", "new"); // the same pair again counts once
    remind(root, "C-3", "C-4", "new");
    remind(root, "C-6", "C-5", "new");
    remind(root, "C-7", "C-1", "new");
    answer(root, "C-2", "C-1", true); // either order
    answer(root, "C-3", "C-4", false);
    answer(root, "C-3", "C-4", true); // the latest counts
    answer(root, "C-6", "C-5", false);
    remind(root, "C-3", "C-6", "land");
    const r = cli(root, "stats");
    expect(r.code).toBe(0);
    expect(section(r.out)).toEqual([
      "Duplicate reminders",
      "  new: reminded 4 pair(s), answered 3 (same 2, not 1), unanswered 1, precision 67%, one side dropped since 1",
      "  land: reminded 1 pair(s), answered 0 (same 0, not 0), unanswered 1, precision -, one side dropped since 0",
    ]);
    expect(cli(root, "stats", "--json").out).not.toContain("Duplicate");
  });

  test("BR-2659: --since counts only reminders after it; none in range: no section", () => {
    const root = repo({ 1: "open", 2: "open" });
    expect(section(cli(root, "stats").out)).toEqual([]);
    remind(root, "C-1", "C-2", "land");
    const after = remind(root, "C-1", "C-2", "land");
    expect(section(cli(root, "stats", "--since", String(after)).out)).toEqual([]);
    expect(section(cli(root, "stats", "--since", String(after - 1)).out)).toEqual(["Duplicate reminders", "  land: reminded 1 pair(s), answered 0 (same 0, not 0), unanswered 1, precision -, one side dropped since 0"]);
  });
});
