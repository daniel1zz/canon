import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdClaim, takeClaim } from "../claims/claims.ts";
import { processOf, type Proc } from "../claims/liveness.ts";
import { ask } from "../humans/questions.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { noticeOverlaps } from "./overlap.ts";
import { LESSON_REMINDER, stop } from "./session.ts";
import { hang, project, sh, startNew, ws } from "../testkit.ts";

// reason: these cases spawn the CLI, which under load can take seconds per run (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

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
    expect([empty.code, empty.out]).toEqual([0, "Claims:\nLanding queue:\nLandings with no result yet:\nHandoffs:\nQuestions waiting for a human: 0\n"]);
    const s = startNew(root, "Status");
    stop(ws(s.worktree), "land it", undefined, false);
    ask(ws(root).db, "agent:a", null, "which way?", []);
    const text = canon(root, "work", "status").out.split("\n");
    expect(text[0]).toBe("Claims:");
    expect(text[1]).toMatch(new RegExp(`^  ${s.change}\\s+agent:a  ${s.worktree}  until \\S+$`));
    expect(text[2]).toBe("Landing queue:");
    expect(text[3]).toBe("Landings with no result yet:");
    expect(text[4]).toBe("Handoffs:");
    expect(text[5]).toMatch(new RegExp(`^  ${s.change}\\s+next: land it  \\(agent:a, \\S+\\)$`));
    expect(text[6]).toBe("Questions waiting for a human: 1");
    const data = JSON.parse(canon(root, "work", "status", "--json").out);
    expect(Object.keys(data)).toEqual(["claims", "queue", "landings", "resolving", "handoffs", "questions"]);
    expect(data.claims.map((c: { subject: string }) => c.subject)).toEqual([s.change]);
    expect(data.handoffs.map((h: { next: string }) => h.next)).toEqual(["land it"]);
    expect(data.questions.length).toBe(1);
    expect([data.queue, data.landings, data.resolving]).toEqual([[], [], []]);
    ws(root).db.db.query("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(canon(root, "work", "status").out).toContain(`  ${s.change}`);
  });
});

/** A process that existed and is gone now: a claim naming it no longer binds (BR-2100). */
async function deadProcess(): Promise<Proc> {
  const p = hang();
  const proc = processOf(p.pid);
  if (!proc) throw new Error("no start time for a live child");
  p.kill("SIGKILL");
  await p.exited;
  return proc;
}

const planned = (root: string, ...ids: string[]) => {
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  for (const id of ids) writeFileSync(join(root, `canon/changes/${id}.md`), `---\nid: ${id}\ntitle: Planned ${id}\nstatus: open\n---\n## 为什么\n\nx\n`);
  writeFileSync(join(root, "canon/backlog.md"), ids.map((id) => `- ${id}`).reverse().join("\n") + "\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "planned changes");
};

describe("claims that no longer bind", () => {
  test("BR-2192: status lists an expired claim and one whose session process exited, each marked, and --json gives each state", async () => {
    const root = project();
    planned(root, "C-1", "C-2", "C-3");
    const db = ws(root).db;
    for (const id of ["C-1", "C-2", "C-3"]) if (!takeClaim(db, id, `/wt/${id}`, "agent:b").ok) throw new Error("claim refused");
    db.db.query("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z' WHERE subject = 'C-1'").run();
    const dead = await deadProcess();
    db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = 'C-2'").run(dead.pid, dead.start);
    const lines = canon(root, "work", "status").out.split("\n");
    expect(lines.find((l) => l.startsWith("  C-1"))).toEndWith("until 2000-01-01T00:00:00.000Z  (expired: lease ended)");
    expect(lines.find((l) => l.startsWith("  C-2"))).toEndWith("(expired: session process exited)");
    expect(lines.find((l) => l.startsWith("  C-3"))).not.toContain("expired");
    const data = JSON.parse(canon(root, "work", "status", "--json").out);
    expect(data.claims.map((c: { subject: string; state: string }) => [c.subject, c.state])).toEqual([["C-1", "expired"], ["C-2", "holder-gone"], ["C-3", "live"]]);
  });

  test("BR-2149: brief marks (claimed) only on a claim that still binds, not on an expired one or one whose session process exited", async () => {
    const root = project();
    planned(root, "C-1", "C-2", "C-3");
    const db = ws(root).db;
    for (const id of ["C-1", "C-2", "C-3"]) if (!takeClaim(db, id, `/wt/${id}`, "agent:b").ok) throw new Error("claim refused");
    db.db.query("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z' WHERE subject = 'C-1'").run();
    const dead = await deadProcess();
    db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = 'C-2'").run(dead.pid, dead.start);
    const r = canon(root, "brief");
    expect(r.code).toBe(0);
    expect(r.out).toContain("with no task, take the first unclaimed, not ambiguous one: C-3 (claimed), C-2, C-1\n");
  });
});

describe("stop while the worktree is being deleted", () => {
  test("BR-2025: stop in a worktree a clean or drop is removing right now exits 5, saying so, and records no handoff; once that hold is dead it exits 3", async () => {
    const root = project();
    const s = startNew(root, "Going");
    stop(ws(s.worktree), "release it", undefined, true);
    const db = ws(root).db;
    db.db.query("DELETE FROM handoffs").run();
    const hold = holdClaim(db, s.change, s.worktree, "human:x");
    if (!hold.ok) throw new Error(hold.error.message);
    const r = canon(s.worktree, "work", "stop", "--next", "x");
    expect(r.code).toBe(5);
    expect(r.err).toContain("being deleted");
    expect(db.db.query("SELECT 1 FROM handoffs").all()).toEqual([]);
    const dead = await deadProcess();
    db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(dead.pid, dead.start, s.change);
    expect(canon(s.worktree, "work", "stop", "--next", "x").code).toBe(3);
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

describe("the overview line of the guide", () => {
  const LINE = "- Read canon/architecture.md first.";

  test("BR-2090: with canon/architecture.md the guide starts with the line telling to read it, in the main checkout and in a change's worktree; without it there is no such line", () => {
    const root = project();
    const without = canon(root, "brief");
    expect(without.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
    expect(without.out).not.toContain("canon/architecture.md");
    writeFileSync(join(root, "canon/architecture.md"), "---\ntitle: 架构总览\n---\n# 架构总览\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "overview");
    const first = canon(root, "brief").out.split("\n");
    expect(first[0]).toBe(WORKFLOW_GUIDE.split("\n")[0]);
    expect(first[1]).toBe(LINE);
    expect(canon(root, "brief").out.replace(`${LINE}\n`, "").startsWith(WORKFLOW_GUIDE)).toBe(true);
    const s = startNew(root, "Some work");
    expect(canon(s.worktree, "brief").out.split("\n")[1]).toBe(LINE);
  });

  test("BR-2090: outside a git repository the guide has no overview line and the failure follows", () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-brief-"));
    const r = canon(dir, "brief");
    expect(r.code).toBe(4);
    expect(r.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
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
    // reason: the new active rule is executed by this change, so its close needs evidence: an acceptance line (BR-2241)
    const changeFile = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(`${s.change}-`) || f === `${s.change}.md`)!);
    writeFileSync(changeFile, `${readFileSync(changeFile, "utf8").trimEnd()}\n\n## 验收\n\n- ${rule}：退一笔 → 已退\n`);
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
