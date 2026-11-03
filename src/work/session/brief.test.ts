import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeClaim } from "../claims/claims.ts";
import { ask } from "../humans/questions.ts";
import { WORKFLOW_GUIDE } from "../../cli/guide.ts";
import { noticeOverlaps } from "./overlap.ts";
import { LESSON_REMINDER, stop } from "./session.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

// reason: these cases spawn the CLI, which under load can take seconds per run (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const commitFile = (wt: string, file: string, text: string) => {
  writeFileSync(join(wt, file), text);
  sh(wt, "add", file);
  sh(wt, "commit", "-qm", file);
};

/** A worktree under the change worktree directory whose branch shares no history with main, so `git diff main...` fails. */
function orphanWorktree(root: string): { path: string; branch: string } {
  const path = `${join(root, "..", root.split("/").pop()!)}.worktrees/C-9`;
  sh(root, "worktree", "add", "-q", "--orphan", "-b", "change/C-9-orphan", path);
  commitFile(path, "shared.txt", "orphan\n");
  return { path, branch: "change/C-9-orphan" };
}

describe("canon work status", () => {
  test("BR-2192: status lists claims, queue, handoffs and the question count, and --json gives the same lists", () => {
    const root = project();
    const empty = canon(root, "work", "status");
    expect([empty.code, empty.out]).toEqual([0, "Claims:\nLanding queue:\nHandoffs:\nQuestions waiting for a human: 0\n"]);
    const s = startNew(root, "Status");
    stop(ws(s.worktree), "land it", undefined, false);
    ask(ws(root).db, "agent:a", null, "which way?", []);
    const text = canon(root, "work", "status").out.split("\n");
    expect(text[0]).toBe("Claims:");
    expect(text[1]).toMatch(new RegExp(`^  ${s.change}\\s+agent:a  ${s.worktree}  until \\S+$`));
    expect(text[2]).toBe("Landing queue:");
    expect(text[3]).toBe("Handoffs:");
    expect(text[4]).toMatch(new RegExp(`^  ${s.change}\\s+next: land it  \\(agent:a, \\S+\\)$`));
    expect(text[5]).toBe("Questions waiting for a human: 1");
    const data = JSON.parse(canon(root, "work", "status", "--json").out);
    expect(Object.keys(data)).toEqual(["claims", "queue", "resolving", "handoffs", "questions"]);
    expect(data.claims.map((c: { subject: string }) => c.subject)).toEqual([s.change]);
    expect(data.handoffs.map((h: { next: string }) => h.next)).toEqual(["land it"]);
    expect(data.questions.length).toBe(1);
    expect([data.queue, data.resolving]).toEqual([[], []]);
    ws(root).db.db.query("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(canon(root, "work", "status").out).toContain(`  ${s.change}`);
  });
});

describe("overlap comparisons that fail", () => {
  test("BR-2062: a branch git cannot compare with main is said, not taken for no overlap, and nothing is refused", () => {
    const root = project();
    const s = startNew(root, "A");
    commitFile(s.worktree, "shared.txt", "a\n");
    const o = orphanWorktree(root);
    const lines: string[] = [];
    const found = noticeOverlaps(ws(s.worktree), s.worktree, s.change, "land", (l) => lines.push(l));
    expect(found).toEqual([]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith(`overlap: cannot compare ${o.branch} with main: `);
  });

  test("BR-2063: brief says a failed comparison, prints overlaps without writing overlap.notice", () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    commitFile(a.worktree, "shared.txt", "a\n");
    commitFile(b.worktree, "shared.txt", "b\n");
    const r = canon(a.worktree, "brief");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Overlap: ${b.change} also changes shared.txt`);
    expect(ws(root).db.db.query("SELECT 1 FROM events WHERE kind = 'overlap.notice'").all()).toEqual([]);
    const o = orphanWorktree(root);
    const again = canon(a.worktree, "brief");
    expect(again.code).toBe(0);
    expect(again.out).toContain(`Overlap check failed: cannot compare ${o.branch} with main: `);
    expect(again.out).toContain(`Overlap: ${b.change} also changes shared.txt`);
  });
});

describe("brief failures on stdout", () => {
  test("BR-2090: a broken config's reason appears on stdout after the guide", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "main: [\n");
    const r = canon(root, "brief");
    expect(r.code).toBe(2);
    expect(r.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
    const after = r.out.slice(WORKFLOW_GUIDE.length);
    expect(after).toContain("canon brief failed: canon/config.yaml: not valid YAML");
    expect(after).toContain("run canon brief again");
  });

  test("BR-2090 BR-2022: main's canon/ that git cannot read exits 4, not 70, and says why on stdout", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Only on main\nstatus: open\n---\n## 为什么\n\nx\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "a change on main");
    const blob = sh(root, "rev-parse", "main:canon/changes/C-1.md");
    sh(root, "checkout", "-q", "-b", "other", "main~1");
    rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const r = canon(root, "brief");
    expect(r.code).toBe(4);
    expect(r.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
    expect(r.out).toContain("canon brief failed: cannot read canon/ from main");
  });
});

describe("the lessons reminder comes last", () => {
  test("BR-2163: review notes and the after_land log path of land --finish, and after_stop's output, come before the lessons line", () => {
    const root = project();
    const rule = ["BR", 1].join("-");
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > /dev/null; echo ''{"verdict":"ok","findings":["${rule} is vague"]}'''\nhooks:\n  after_stop: "echo stopped-hook"\n  after_land: "echo landed-hook"\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), "");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "Notes");
    const stopped = canon(s.worktree, "work", "stop", "--next", "write the rule");
    expect(stopped.code).toBe(0);
    const stopLines = stopped.out.trim().split("\n");
    expect(stopLines.at(-1)).toBe(LESSON_REMINDER);
    expect(stopLines.findIndex((l) => l.includes("stopped-hook"))).toBeGreaterThan(-1);
    writeFileSync(join(s.worktree, `canon/rules/billing/${rule}.md`), `---\nid: ${rule}\ntitle: 退款\nstatus: active\nuntested: fixture\n---\n## 规则\n\n退款。\n\n## 例子\n\n- 退 → 退\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const landed = canon(s.worktree, "work", "land", "--finish");
    expect([landed.code, landed.err]).toEqual([0, ""]);
    const lines = landed.out.trim().split("\n");
    expect(lines.at(-1)).toBe(LESSON_REMINDER);
    const note = lines.findIndex((l) => l === `review note: ${rule} is vague`);
    const log = lines.findIndex((l) => /^after_land .*running in the background \(log: /.test(l));
    expect(note).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(-1);
    expect(Math.max(note, log)).toBeLessThan(lines.length - 1);
  });
});
