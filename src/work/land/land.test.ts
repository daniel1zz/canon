import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, renewClaim, takeClaim } from "../claims/claims.ts";
import { enqueue, finishEntry, tryTurn } from "./queue.ts";
import { handoffs, writeHandoff } from "../session/handoffs.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { clean, start, stop } from "../session/session.ts";
import { land, LAND_MARKER, predictedConflicts, reopen } from "./land.ts";
import { ensureGuard } from "../../cli/install/githook.ts";
import { processOf, type Proc } from "../claims/liveness.ts";

import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;

describe("rule review at land", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return { root, promptFile };
  }

  test("BR-2009 BR-2036: a block verdict on changed rule text refuses the landing; the reviewer saw the whole domain and the index of every rule", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("is vague");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Domain: billing");
    expect(prompt).toContain(`- ${id} [billing] Refunds`);
    expect(prompt).toContain("language the documents are written in");
    expect(prompt).toContain("One rule is one trigger"); // the split criterion of D-5
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2009: a reviewer that fails to run refuses the landing", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("could not run");
  });

  test("BR-2074: changed rule text without a configured reviewer lands with a notice and a review.skip event", async () => {
    const root = project();
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const lines: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(lines.join("\n")).toContain("review: not configured");
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.skip'").get()?.n).toBe(1);
  });

  test("BR-2009: changing only a domain README is reviewed, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Readme only");
    writeFileSync(join(s.worktree, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nRules here are optional.\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(s.worktree, "commit", "-qam", "readme");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(readFileSync(promptFile, "utf8")).toContain("Rules here are optional.");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2009: deleting a rule file is reviewed with the text it had on main, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`);
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"block","findings":["deleting it drops a promise"]}'''\n`);
    sh(root, "commit", "-qam", "blocking reviewer");
    const s = startNew(root, "Delete rule");
    sh(s.worktree, "rm", "-q", `canon/rules/billing/${id}.md`);
    sh(s.worktree, "commit", "-qm", "delete");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/${id}.md`);
    expect(prompt).toContain("Refunds within 30 days.");
  });

  test("BR-2009: a rule file moved with identical content is not reviewed; moved and edited is reviewed as deleted plus added", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const text = `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`;
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), text);
    mkdirSync(join(seed.worktree, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(seed.worktree, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    rmSync(promptFile, { force: true });

    const move = startNew(root, "Move rule");
    sh(move.worktree, "mv", `canon/rules/billing/${id}.md`, `canon/rules/billing/refunds/${id}.md`);
    sh(move.worktree, "commit", "-qm", "move");
    const lines: string[] = [];
    expect((await land(ws(move.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    expect(lines).toContain("review: 1 file(s) only moved, not reviewed");

    const edit = startNew(root, "Move and edit");
    sh(edit.worktree, "mv", `canon/rules/billing/refunds/${id}.md`, `canon/rules/billing/${id}.md`);
    writeFileSync(join(edit.worktree, `canon/rules/billing/${id}.md`), text.replace("30", "31"));
    sh(edit.worktree, "commit", "-qam", "move and edit");
    expect((await land(ws(edit.worktree), FAST, quiet)).kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Refunds within 31 days.");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/refunds/${id}.md`);
  });

  test("BR-2010: the reviewer is not asked when no rule or decision text changed", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Code only");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "code");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("duplicate review of standing instructions at land", () => {
  const GUIDE = "- Ask the human only about direction.";
  function standingProject(verdict: "ok" | "block", extra = "") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-standing.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${extra}review: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["CLAUDE.md repeats the guide"]}'''\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, ".claude/skills/x"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing tests\n---\nbody\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "standing");
    return { root, promptFile };
  }

  test("BR-2143: a block verdict on an edited CLAUDE.md refuses the landing; the reviewer saw the new text, the guide and the skill descriptions", async () => {
    const { root, promptFile } = standingProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Only ask the human about direction.\n");
    sh(s.worktree, "commit", "-qam", "instructions");
    const out = await land(ws(s.worktree), { ...FAST, guide: GUIDE }, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("CLAUDE.md repeats the guide");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Changed in this landing: CLAUDE.md");
    expect(prompt).toContain("Only ask the human about direction.");
    expect(prompt).toContain(GUIDE);
    expect(prompt).toContain(".claude/skills/x/SKILL.md: Use when writing tests");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2143: an edited skill is reviewed and an ok verdict lands", async () => {
    const { root, promptFile } = standingProject("ok");
    const s = startNew(root, "Edit skill");
    writeFileSync(join(s.worktree, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing or reviewing tests\n---\nbody\n");
    sh(s.worktree, "commit", "-qam", "skill");
    expect((await land(ws(s.worktree), { ...FAST, guide: GUIDE }, quiet)).kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("# Changed in this landing: .claude/skills/x/SKILL.md");
  });

  test("BR-2143: with instructions configured, only the listed files trigger the review; code alone and deletions never do", async () => {
    const { root, promptFile } = standingProject("block", "instructions: [docs/agent.md]\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/agent.md"), "# Agent\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "agent doc");
    const a = startNew(root, "Edit CLAUDE.md only");
    writeFileSync(join(a.worktree, "CLAUDE.md"), "# Project\n\nmore\n");
    writeFileSync(join(a.worktree, "app.txt"), "code\n");
    sh(a.worktree, "add", "-A");
    sh(a.worktree, "commit", "-qm", "not listed");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    const d = startNew(root, "Delete the listed file");
    sh(d.worktree, "rm", "-q", "docs/agent.md");
    sh(d.worktree, "commit", "-qm", "delete");
    expect((await land(ws(d.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    const b = startNew(root, "Add the listed file back");
    mkdirSync(join(b.worktree, "docs"), { recursive: true });
    writeFileSync(join(b.worktree, "docs/agent.md"), "# Agent\n\nnew\n");
    sh(b.worktree, "add", "-A");
    sh(b.worktree, "commit", "-qm", "listed");
    const out = await land(ws(b.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(readFileSync(promptFile, "utf8")).toContain("# docs/agent.md (instruction file, loaded whole)");
  });

  test("BR-2143: an edited CLAUDE.md without a configured reviewer lands with a notice and a review.skip event", async () => {
    const root = project();
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "claude");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const lines: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(lines.join("\n")).toContain("review: not configured — CLAUDE.md");
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.skip'").get()?.n).toBe(1);
  });

  test("BR-2143: a duplicate reviewer that fails to run refuses the landing", async () => {
    const { root } = standingProject("ok");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    sh(root, "commit", "-qam", "failing reviewer");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("duplicate review could not run");
  });
});

describe("work land", () => {
  test("BR-2017 BR-2039: lands a committed branch: main moves and the primary checkout's files follow", async () => {
    const root = project();
    const s = startNew(root, "Add four");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "four");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).toBe(sh(s.worktree, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "app.txt"), "utf8")).toContain("four");
  });

  test("BR-2125: with canon's git guard installed, land still moves main, both when main is checked out and when it is not, and leaves no marker behind", async () => {
    const root = project();
    expect(ensureGuard(root, "main")).toEqual({ ok: true, value: true });
    writeFileSync(join(root, "app.txt"), "direct\n");
    expect(Bun.spawnSync(["git", "commit", "-qam", "direct"], { cwd: root }).exitCode).not.toBe(0); // the guard is live
    sh(root, "checkout", "-q", "--", "app.txt");
    const a = startNew(root, "Checked out");
    writeFileSync(join(a.worktree, "a.txt"), "a\n");
    sh(a.worktree, "add", "a.txt");
    sh(a.worktree, "commit", "-qm", "a");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(join(root, "a.txt"))).toBe(true); // the primary checkout followed main (BR-2039)
    sh(root, "checkout", "-q", "--detach");
    const b = startNew(root, "Detached");
    writeFileSync(join(b.worktree, "b.txt"), "b\n");
    sh(b.worktree, "add", "b.txt");
    sh(b.worktree, "commit", "-qm", "b");
    expect((await land(ws(b.worktree), FAST, quiet)).kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).toBe(sh(b.worktree, "rev-parse", "HEAD"));
    expect(process.env[LAND_MARKER]).toBeUndefined();
  });

  test("BR-2013 BR-2014 BR-2015: refuses uncommitted work, a red floor and a rebase conflict, leaving main untouched", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");

    const a = startNew(root, "Dirty");
    writeFileSync(join(a.worktree, "app.txt"), "changed\n");
    const dirty = await land(ws(a.worktree), FAST, quiet);
    expect(dirty.kind === "refused" && dirty.reason).toBe("dirty");

    const b = startNew(root, "Red");
    writeFileSync(join(b.worktree, "FAIL"), "x");
    sh(b.worktree, "add", "FAIL");
    sh(b.worktree, "commit", "-qm", "red");
    const red = await land(ws(b.worktree), FAST, quiet);
    expect(red.kind === "refused" && red.reason).toBe("floor");
    expect(sh(root, "rev-parse", "main")).toBe(before);

    const c = startNew(root, "Edit two");
    const d = startNew(root, "Edit two again");
    writeFileSync(join(c.worktree, "app.txt"), "one\nTWO\nthree\n");
    sh(c.worktree, "commit", "-qam", "c");
    writeFileSync(join(d.worktree, "app.txt"), "one\n2\nthree\n");
    sh(d.worktree, "commit", "-qam", "d");
    expect((await land(ws(c.worktree), FAST, quiet)).kind).toBe("landed");
    const conflict = await land(ws(d.worktree), FAST, quiet);
    expect(conflict.kind === "refused" && conflict.reason).toBe("conflict");
    expect(sh(d.worktree, "status", "--porcelain")).toBe(""); // rebase was aborted, work intact
  });

  test("BR-2017: main that moved while the floor ran stays where it was moved, and the landing is refused", async () => {
    const root = project();
    const s = startNew(root, "Racing");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "git -C ${root} commit -q --allow-empty -m moved-meanwhile"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that moves main");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("main-moved");
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("moved-meanwhile");
  });

  test("BR-2106: a commit made in the worktree while the floor runs is refused as moved-during-land, naming it; main stays", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Sneaky commit");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "git commit -q --allow-empty -m sneaky"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that commits");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("moved-during-land");
    expect(out.kind === "refused" && out.message).toContain("sneaky");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2106: an uncommitted file left in the worktree after the floor is refused as moved-during-land, naming it", async () => {
    const root = project();
    const s = startNew(root, "Stray file");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "echo x > stray.txt"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that writes a file");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("moved-during-land");
    expect(out.kind === "refused" && out.message).toContain("stray.txt");
  });

  test("BR-2106: a floor that leaves HEAD and the worktree as they were lands the tested commit", async () => {
    const root = project();
    const s = startNew(root, "Clean floor");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "landed" && out.sha).toBe(sh(s.worktree, "rev-parse", "HEAD"));
  });

  test("BR-2105: uncommitted edits made while waiting in the queue are refused as dirty, naming the files, not as a conflict", async () => {
    const root = project();
    const s = startNew(root, "Edited while waiting");
    writeFileSync(join(s.worktree, "app.txt"), "one\nTWO\nthree\n");
    sh(s.worktree, "commit", "-qam", "two");
    writeFileSync(join(root, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(root, "commit", "-qam", "main edits app.txt too"); // a rebase would touch app.txt, without a conflict (BR-2153)
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(s.worktree, "app.txt"), "edited while waiting\n");
    finishEntry(other.db, ahead, "landed", "x");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("dirty");
    expect(out.kind === "refused" && out.message).toContain("app.txt");
    expect(readFileSync(join(s.worktree, "app.txt"), "utf8")).toBe("edited while waiting\n");
  });

  test("BR-2039 BR-2026: a primary checkout with uncommitted changes on main keeps main still; the reason is main-dirty", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Blocked by dirty main");
    writeFileSync(join(s.worktree, "new.txt"), "x\n");
    sh(s.worktree, "add", "new.txt");
    sh(s.worktree, "commit", "-qm", "x");
    writeFileSync(join(root, "app.txt"), "local edit\n");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("main-dirty");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("local edit\n");
  });

  test("BR-2016: refuses when canon check finds a broken corpus", async () => {
    const root = project();
    const s = startNew(root, "Bad ref");
    writeFileSync(join(s.worktree, "canon/changes/C-1-bad-ref.md"), "---\nid: C-1\ntitle: Bad ref\n---\n## 为什么\n\nSee D-99.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n");
    sh(s.worktree, "commit", "-qam", "dangling");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => f.rule)).toEqual(["ref-dangling"]);
  });

  describe("BR-2111: a new decision needs a source; each source new to main is verified against its file or page", () => {
    const decision = (options: string) =>
      `---\nid: D-1\ntitle: Pick\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n${options}\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    const pages: Record<string, string> = { "https://ok.example/a": "<html><body><p>refunds are&nbsp;allowed\n  within 30 days</p></body></html>" };
    const fetcher = async (url: string) => {
      if (url === "https://down.example/") throw new Error("getaddrinfo ENOTFOUND down.example");
      return url in pages ? { status: 200, text: pages[url]! } : { status: 404, text: "not found" };
    };
    const attempt = async (options: string, title: string) => {
      const root = project();
      const s = startNew(root, title);
      writeFileSync(join(s.worktree, "refund.txt"), "export function refund(order) {}\n");
      mkdirSync(join(s.worktree, "canon/decisions"), { recursive: true });
      writeFileSync(join(s.worktree, "canon/decisions/D-1.md"), decision(options));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "decision");
      const out = await land(ws(s.worktree), { ...FAST, fetcher }, quiet);
      return out.kind === "refused" ? `${out.reason}: ${out.message.split("\n").slice(1).join(" ").trim()}` : out.kind;
    };
    // reason: one landing per test, not eight in one, so each case has the whole timeout to itself under load (C-111).
    const cases: [string, string, string][] = [
      ["No source", "", "source: - D-1 is new and cites no source under ## 方案 (来源：<URL or repository path> “<quote>”)"],
      ["File ok", "   - 来源：refund.txt “export function refund(order)”", "landed"],
      ["File wrong", "   - 来源：refund.txt “export function refund(item)”", "source: - D-1: refund.txt does not contain “export function refund(item)”"],
      ["File missing", "   - 来源：missing.txt “export function refund(order)”", "source: - D-1: missing.txt is not a file in the repository"],
      ["Page ok", "   - 来源：https://ok.example/a “refunds are allowed within 30 days”", "landed"],
      ["Page wrong", "   - 来源：https://ok.example/a “refunds are allowed within 60 days”", "source: - D-1: https://ok.example/a does not contain “refunds are allowed within 60 days”"],
      ["Page 404", "   - 来源：https://ok.example/gone “refunds are allowed within 30 days”", "source: - D-1: https://ok.example/gone answered HTTP 404"],
      ["Offline", "   - 来源：https://down.example/ “refunds are allowed within 30 days”", "source: - D-1: https://down.example/ could not be fetched (getaddrinfo ENOTFOUND down.example)"],
    ];
    for (const [title, options, expected] of cases) {
      test(`BR-2111: ${title}`, async () => {
        expect(await attempt(options, title)).toBe(expected);
      });
    }
  });

  test("BR-2111: a source already on main is not fetched again, and editing an old decision needs no new source", async () => {
    const root = project();
    const s = startNew(root, "First");
    mkdirSync(join(s.worktree, "canon/decisions"), { recursive: true });
    const body = (extra: string) =>
      `---\nid: D-1\ntitle: Pick\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n   - 来源：https://ok.example/a “refunds are allowed within 30 days”\n2. B：否决${extra}。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    writeFileSync(join(s.worktree, "canon/decisions/D-1.md"), body(""));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "decision");
    const fetched: string[] = [];
    const fetcher = async (url: string) => (fetched.push(url), { status: 200, text: "refunds are allowed within 30 days" });
    expect((await land(ws(s.worktree), { ...FAST, fetcher }, quiet)).kind).toBe("landed");
    const t = startNew(root, "Second");
    writeFileSync(join(t.worktree, "canon/decisions/D-1.md"), body("，太慢"));
    sh(t.worktree, "commit", "-qam", "reword");
    const offline = async (url: string) => (fetched.push(url), Promise.reject(new Error("offline")));
    expect((await land(ws(t.worktree), { ...FAST, fetcher: offline }, quiet)).kind).toBe("landed");
    expect(fetched).toEqual(["https://ok.example/a"]);
  });

  test("BR-2018 BR-2019: --finish closes the change, releases the claim, and clean removes only fully landed worktrees", async () => {
    const root = project();
    const done = startNew(root, "Done one");
    writeFileSync(join(done.worktree, "new.txt"), "x\n");
    sh(done.worktree, "add", "new.txt");
    sh(done.worktree, "commit", "-qm", "x");
    const out = await land(ws(done.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
    const change = readCorpus(root).corpus.docs.find((d) => d.id === "C-1");
    expect(change?.kind === "change" && change.status).toBe("done");
    expect(claims(ws(root).db)).toEqual([]);

    const open = startNew(root, "Unlanded");
    writeFileSync(join(open.worktree, "wip.txt"), "wip\n");
    sh(open.worktree, "add", "wip.txt");
    sh(open.worktree, "commit", "-qm", "wip");
    stop(ws(open.worktree), "finish wip", undefined, true);

    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([done.worktree]);
    expect(existsSync(open.worktree)).toBe(true);
    expect(r.value.kept.join("\n")).toContain("not on main");
  });
});

describe("lessons when a change closes", () => {
  const setLessons = (wt: string, change: string, lessons: string | undefined) => {
    const name = readdirSync(join(wt, "canon/changes")).find((f) => f === `${change}.md` || f.startsWith(`${change}-`))!;
    const path = join(wt, "canon/changes", name);
    const text = readFileSync(path, "utf8").replace(/\n## 教训\n\n[^#]*/, "\n");
    writeFileSync(path, lessons === undefined ? text : text.replace("\n## 任务", `\n## 教训\n\n${lessons}\n\n## 任务`));
    sh(wt, "commit", "-qam", "lessons");
  };
  const subjects = (root: string) => sh(root, "log", "--format=%s", "main");

  test("BR-2161: --finish refuses an open change without a filled lessons section, before any close commit", async () => {
    const root = project();
    const s = startNew(root, "No lessons");
    setLessons(s.worktree, s.change, undefined);
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out).toMatchObject({ kind: "refused", reason: "lessons" });
    expect(out.kind === "refused" && out.message).toContain("## 教训");
    expect(sh(s.worktree, "log", "-1", "--format=%s")).toBe("lessons"); // no close commit
    expect(subjects(root)).not.toContain(`close ${s.change}`);

    setLessons(s.worktree, s.change, "<每条教训一行>");
    expect(await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "lessons" });
  });

  test("BR-2161: a lessons section saying 无 closes the change; land without --finish never asks for it", async () => {
    const root = project();
    const plain = startNew(root, "Plain land");
    setLessons(plain.worktree, plain.change, undefined);
    expect((await land(ws(plain.worktree), FAST, quiet)).kind).toBe("landed");
    const s = startNew(root, "With lessons"); // startNew writes "## 教训\n\n无。"
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
  });
});

describe("boundaries record and clean up", () => {
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind);

  test("BR-2026: early land refusals and a refused claim are recorded with their reason", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    await land(ws(s.worktree), FAST, quiet);
    expect(await land(ws(root), FAST, quiet)).toMatchObject({ kind: "refused", reason: "on-main" });
    takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    const reasons = events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason);
    expect(reasons).toEqual(["dirty", "on-main"]);
    expect(events(root, "claim.refuse").map((e) => e.subject)).toEqual([s.change]);
  });

  test("BR-2026: starting a missing or closed change, and --finish without a claim, are recorded with their own reasons", async () => {
    const root = project();
    const s = startNew(root, "Closed");
    expect((await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    expect(start(ws(root), { change: s.change }, quiet).ok).toBe(false);
    expect(start(ws(root), { change: "C-99" }, quiet).ok).toBe(false);
    expect(events(root, "start.refuse").map((e) => [e.subject, JSON.parse(e.detail).reason])).toEqual([
      [s.change, "not-open"],
      ["C-99", "not-found"],
    ]);
    sh(root, "worktree", "add", "-q", "-b", "loose", join(root, "..", `${root.split("/").pop()}-loose`), "main");
    const loose = join(root, "..", `${root.split("/").pop()}-loose`);
    expect(await land(ws(loose), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "no-claim" });
  });

  test("BR-2043: a project without a floor cannot land anything", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "tests: []\n");
    sh(root, "commit", "-qam", "no floor");
    const s = startNew(root, "No floor");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("no-floor");
  });

  test("BR-2048: a lander that waits past its timeout gives up and records it", async () => {
    const root = project();
    const s = startNew(root, "Waiting");
    writeFileSync(join(s.worktree, "w.txt"), "w\n");
    sh(s.worktree, "add", "w.txt");
    sh(s.worktree, "commit", "-qm", "w");
    const other = ws(root);
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else is landing right now
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 0 }, quiet);
    expect(out).toEqual({ kind: "timeout", ahead: 1 });
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["timeout"]);
  });

  test("BR-2049: the heartbeat runs through the whole landing, so a slow step is not mistaken for a dead lander", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nlander_stale_minutes: 0.02\nhooks:\n  before_land: sleep 3\n");
    sh(root, "commit", "-qam", "slow before_land, 1.2 s stale time");
    const s = startNew(root, "Slow");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const other = ws(root, "agent:b");
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(2200); // well past the 1.2 s stale time, while before_land still sleeps
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b, 1200).mine).toBe(false);
    expect((await landing).kind).toBe("landed");
    expect(tryTurn(other.db, b, 1200).mine).toBe(true);
  }, TIMED);

  test("BR-2144: a lander whose waiting entry was marked abandoned is refused when it wakes, and nothing moves", async () => {
    const root = project();
    const s = startNew(root, "Skipped");
    writeFileSync(join(s.worktree, "s.txt"), "s\n");
    sh(s.worktree, "add", "s.txt");
    sh(s.worktree, "commit", "-qm", "s");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const before = sh(root, "rev-parse", "main");
    const landing = land(ws(s.worktree), FAST, quiet);
    let mine: number | undefined;
    for (let i = 0; i < 50 && mine === undefined; i++) {
      await Bun.sleep(100);
      mine = other.db.db.query<{ id: number }, [string]>("SELECT id FROM queue WHERE worktree = ?").get(s.worktree)?.id;
    }
    // A later lander saw this entry silent past the stale time and skipped it; then the one ahead finishes.
    other.db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE id = ?").run(mine!);
    finishEntry(other.db, ahead, "landed", "x");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("lost-turn");
    expect(out.kind === "refused" && out.message).toContain("main was not moved");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(mine!)?.state).toBe("abandoned");
    expect(events(root, "land.lost").map((e) => JSON.parse(e.detail).stage)).toEqual(["queue"]);
    expect(events(root, "land.refuse")).toEqual([]);
    expect(events(root, "land.turn")).toEqual([]);
  });

  test("BR-2144: a lander marked abandoned during its turn does not move main", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nhooks:\n  before_land: sleep 1.5\n");
    sh(root, "commit", "-qam", "slow before_land");
    const s = startNew(root, "Skipped mid-turn");
    writeFileSync(join(s.worktree, "m.txt"), "m\n");
    sh(s.worktree, "add", "m.txt");
    sh(s.worktree, "commit", "-qm", "m");
    const other = ws(root, "agent:b");
    const before = sh(root, "rev-parse", "main");
    const landing = land(ws(s.worktree), FAST, quiet);
    const landingNow = () => other.db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queue WHERE worktree = ? AND state = 'landing'").get(s.worktree)?.n === 1;
    for (let i = 0; i < 100 && !landingNow(); i++) await Bun.sleep(50);
    await Bun.sleep(300); // inside before_land
    other.db.db.query("UPDATE queue SET state = 'abandoned', result = 'no heartbeat' WHERE worktree = ?").run(s.worktree);
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("lost-turn");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(events(root, "land.lost").map((e) => JSON.parse(e.detail).stage)).toEqual(["before-main"]);
  });

  test("BR-2153: a conflict with a main that moved while waiting refuses at once, before the turn, leaving the worktree as it was", async () => {
    const root = project();
    const s = startNew(root, "Waits and conflicts");
    writeFileSync(join(s.worktree, "app.txt"), "one\n2\nthree\n");
    sh(s.worktree, "commit", "-qam", "mine");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else holds the turn throughout
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(root, "app.txt"), "one\nTWO\nthree\n"); // another change lands meanwhile
    sh(root, "commit", "-qam", "theirs");
    const started = Date.now();
    const out = await landing;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.kind === "refused" && out.reason).toBe("conflict");
    expect(out.kind === "refused" && out.message).toContain("conflicts in: app.txt");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(other.db.db.query<{ state: string }, [string]>("SELECT state FROM queue WHERE worktree = ?").get(s.worktree)?.state).toBe("failed");
    expect(other.db.db.query<{ state: string }, [number]>("SELECT state FROM queue WHERE id = ?").get(ahead)?.state).toBe("landing");
    expect(events(root, "land.turn")).toEqual([]);
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["conflict"]);
  });

  test("BR-2153: a main that moved without a conflict keeps the lander waiting, and it lands after the one ahead", async () => {
    const root = project();
    const s = startNew(root, "Waits cleanly");
    writeFileSync(join(s.worktree, "mine.txt"), "m\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(root, "theirs.txt"), "t\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "theirs");
    await Bun.sleep(2500); // at least one more look at main while waiting
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  }, 20_000); // reason: waits through more than one 2 s queue poll on purpose

  test("BR-2153: a prediction that cannot run is reported, not a refusal", () => {
    const root = project();
    const p = predictedConflicts(root, "0000000000000000000000000000000000000000");
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toContain("git merge-tree exited");
    expect(predictedConflicts(root, "main")).toEqual({ ok: true, files: [] });
  });

  test("BR-2031: landing from main is refused", async () => {
    const root = project();
    const out = await land(ws(root), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("on-main");
  });

  test("BR-2029: a failed setup removes the new worktree and releases the change, so a retry starts clean", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nsetup: \"test -e .ok\"\n");
    sh(root, "commit", "-qam", "setup that fails");
    const first = start(ws(root), { title: "Needs setup" }, quiet);
    expect(first.ok).toBe(false);
    expect(claims(ws(root).db)).toEqual([]);
    const wts = sh(root, "worktree", "list");
    expect(wts.split("\n").length).toBe(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    expect(events(root, "start.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["setup"]);
  });

  test("BR-2030: after_land runs in the background with the landing's commits and never changes the result", async () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-after.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  after_land: 'echo "$CANON_BASE $CANON_HEAD $CANON_CHANGE" > ${marker}; exit 7'\n`);
    sh(root, "commit", "-qam", "after_land");
    const s = startNew(root, "With hook");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(100);
    const [base, head, change] = readFileSync(marker, "utf8").trim().split(" ");
    expect(head).toBe(sh(root, "rev-parse", "main"));
    expect(base).toBe(sh(root, "rev-parse", "main~2")); // the open-change commit and x are the landed ones
    expect(change).toBe(s.change);
  });
});

describe("the claim during a landing", () => {
  test("BR-2108: a landing that waits longer than the lease keeps its claim renewed, so no one takes it meanwhile", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nclaim_lease_hours: 0.0003\n"); // about 1 s
    sh(root, "commit", "-qam", "tiny lease");
    const s = startNew(root, "Long wait");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, quiet);
    await Bun.sleep(2500); // two and a half leases
    expect(takeClaim(other.db, s.change, s.worktree, "agent:b", 1000).ok).toBe(false);
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  }, TIMED);

  test("BR-2018: a refused --finish landing takes its close commit back, so the change stays open", async () => {
    const root = project();
    const s = startNew(root, "Refused finish");
    writeFileSync(join(s.worktree, "FAIL"), "x\n"); // the floor is `test ! -e FAIL`
    sh(s.worktree, "add", "FAIL");
    sh(s.worktree, "commit", "-qm", "breaks the floor");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const before = sh(root, "rev-parse", "main");
    const lines: string[] = [];
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, (l) => lines.push(l));
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
    expect(lines.join("\n")).toContain(`${s.change} reopened`);
    expect(claims(ws(root).db).map((c) => c.subject)).toEqual([s.change]);
  });

  test("BR-2018: taking the close commit back never drops a commit made after the check, nor local edits to the change file", () => {
    const root = project();
    const s = startNew(root, "Reopen race");
    const path = sh(s.worktree, "diff", "--name-only", "main", "HEAD");
    const closeIt = () => {
      writeFileSync(join(s.worktree, path), readFileSync(join(s.worktree, path), "utf8").replace("status: open", "status: done"));
      sh(s.worktree, "commit", "-qam", `canon: close ${s.change}`);
    };
    closeIt();
    const checked = { ok: true as const, value: sh(s.worktree, "rev-parse", "HEAD") };
    writeFileSync(join(s.worktree, "fix.txt"), "fix\n"); // the session commits a fix meanwhile
    sh(s.worktree, "add", "fix.txt");
    sh(s.worktree, "commit", "-qm", "fix");
    const fix = sh(s.worktree, "rev-parse", "HEAD");
    const lines: string[] = [];
    expect(reopen(s.worktree, { subject: s.change, path }, (l) => lines.push(l), checked)).toBe(false);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(fix);
    expect(readFileSync(join(s.worktree, "fix.txt"), "utf8")).toBe("fix\n");
    expect(lines.join("\n")).toContain("was not reopened");
    expect(lines.join("\n")).toContain("says done although it did not land");

    sh(s.worktree, "reset", "-q", "--hard", checked.value);
    writeFileSync(join(s.worktree, path), readFileSync(join(s.worktree, path), "utf8") + "\nlocal note\n");
    const dirty: string[] = [];
    expect(reopen(s.worktree, { subject: s.change, path }, (l) => dirty.push(l))).toBe(false);
    expect(dirty.join("\n")).toContain("was not reopened");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(checked.value);
    expect(readFileSync(join(s.worktree, path), "utf8")).toContain("local note");
  });

  test("BR-2018: a --finish landing that times out in the queue takes its close commit back too", async () => {
    const root = project();
    const s = startNew(root, "Timed out finish");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const out = await land(ws(s.worktree), { finish: true, timeoutMs: 0 }, quiet);
    expect(out.kind).toBe("timeout");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
  });

  test("BR-2018: --finish leaves alone a claim and handoff that another session took over during the landing", async () => {
    const root = project();
    const s = startNew(root, "Taken over");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const lines: string[] = [];
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, (l) => lines.push(l));
    await Bun.sleep(300);
    other.db.db.query("UPDATE claims SET holder = 'agent:b' WHERE subject = ?").run(s.change); // taken over after the lease ran out
    writeHandoff(other.db, { subject: s.change, worktree: s.worktree, actor: "agent:b", next: "mine now", note: null });
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
    expect(claims(other.db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
    expect(handoffs(other.db).map((h) => h.next)).toEqual(["mine now"]);
    expect(lines.join("\n")).toContain("claimed by another session now");
  });
});

describe("the claim names the lander while it lands", () => {
  async function deadProcess(): Promise<Proc> {
    const p = Bun.spawn(["sleep", "30"]);
    const proc = processOf(p.pid);
    if (!proc) throw new Error("no start time for a live child");
    p.kill("SIGKILL");
    await p.exited;
    return proc;
  }
  const pidOf = (root: string, change: string) => ws(root).db.db.query<{ pid: number | null }, [string]>("SELECT pid FROM claims WHERE subject = ?").get(change)?.pid;
  // reason: outside Claude Code, land keeps the session process the claim already names (BR-2100), so a test can set it.
  async function landingAsSession(session: Proc | null, body: (root: string, s: { change: string; worktree: string }, landing: Promise<unknown>) => Promise<void>) {
    const saved = process.env["CLAUDECODE"];
    delete process.env["CLAUDECODE"];
    try {
      const root = project();
      const s = startNew(root, "Session exits");
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(session?.pid ?? null, session?.start ?? null, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const landing = land(ws(s.worktree), FAST, quiet);
      await Bun.sleep(300);
      await body(root, s, (async () => { finishEntry(other.db, ahead, "landed", "x"); return landing; })());
    } finally {
      if (saved === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = saved;
    }
  }

  test("BR-2142: a session that exits while its landing waits does not free the claim until the landing ends", async () => {
    await landingAsSession(await deadProcess(), async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBe(process.pid); // the lander, which is this test process
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(true); // the session is gone
    });
  });

  test("BR-2142: a work command of the session while its landing waits leaves the claim naming the lander", async () => {
    const session = Bun.spawn(["sleep", "30"]);
    const p = processOf(session.pid)!;
    await landingAsSession(p, async (root, s, landing) => {
      expect(renewClaim(ws(root).db, s.worktree, "agent:a", 12 * 3600_000, p).ok).toBe(true); // e.g. `canon work stop` from the session
      expect(pidOf(root, s.change)).toBe(process.pid);
      session.kill();
      await session.exited;
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(true);
    });
  });

  test("BR-2142: a session still running names the claim again after the landing, so it still binds", async () => {
    const session = Bun.spawn(["sleep", "30"]);
    try {
      await landingAsSession(processOf(session.pid)!, async (root, s, landing) => {
        expect(((await landing) as { kind: string }).kind).toBe("landed");
        expect(pidOf(root, s.change)).toBe(session.pid);
        expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      });
    } finally {
      session.kill();
    }
  });

  test("BR-2142: a lander killed with SIGKILL leaves the claim naming a gone process, so it can be taken at once", async () => {
    const root = project();
    const s = startNew(root, "Lander killed");
    const session = Bun.spawn(["sleep", "30"]);
    try {
      const p0 = processOf(session.pid)!;
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(p0.pid, p0.start, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
      delete env["CLAUDECODE"];
      const lander = Bun.spawn(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "land"], { cwd: s.worktree, stdout: "ignore", stderr: "ignore", env });
      for (let i = 0; i < 200 && pidOf(root, s.change) !== lander.pid; i++) await Bun.sleep(50);
      expect(pidOf(root, s.change)).toBe(lander.pid);
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(false);
      lander.kill("SIGKILL");
      await lander.exited;
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(true);
    } finally {
      session.kill();
    }
  }, TIMED);

  test("BR-2142: after a lander is killed with SIGKILL, a work command of the live session names the session again", async () => {
    const root = project();
    const s = startNew(root, "Lander killed, session lives");
    const session = Bun.spawn(["sleep", "30"]);
    try {
      const p0 = processOf(session.pid)!;
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(p0.pid, p0.start, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: "agent:a" };
      delete env["CLAUDECODE"];
      const lander = Bun.spawn(["bun", join(import.meta.dir, "../../cli/main.ts"), "work", "land"], { cwd: s.worktree, stdout: "ignore", stderr: "ignore", env });
      for (let i = 0; i < 200 && pidOf(root, s.change) !== lander.pid; i++) await Bun.sleep(50);
      expect(pidOf(root, s.change)).toBe(lander.pid);
      lander.kill("SIGKILL");
      await lander.exited; // its queue row is still active
      expect(renewClaim(ws(root).db, s.worktree, "agent:a", 12 * 3600_000, p0).ok).toBe(true); // e.g. `canon work stop`
      expect(pidOf(root, s.change)).toBe(session.pid);
      expect(takeClaim(other.db, s.change, s.worktree, "agent:b").ok).toBe(false);
    } finally {
      session.kill();
    }
  }, TIMED);

  test("BR-2142: a lease-only claim names no process during or after the landing", async () => {
    await landingAsSession(null, async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBeNull();
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(pidOf(root, s.change)).toBeNull();
    });
  });
});

describe("a lander killed by a signal", () => {
  const CLI = join(import.meta.dir, "../../cli/main.ts");
  const entryOf = (root: string) => ws(root).db.db.query<{ id: number; state: string; result: string | null }, []>("SELECT id, state, result FROM queue ORDER BY id DESC LIMIT 1").get();
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(50);
    expect(what()).toBe(true);
  };

  test("BR-2099: SIGTERM while the floor runs fails the entry as killed, records it, exits 143, and the next lander goes at once", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"sleep 30\"\ntests: []\n");
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed");
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const logs = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs");
    await until(() => entryOf(root)?.state === "landing" && existsSync(join(logs, `land-${entryOf(root)!.id}.log`))); // the floor runs
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
    const kinds = ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'land.%' AND kind != 'land.turn'").all().map((e) => e.kind);
    expect(kinds).toEqual(["land.killed"]); // an interruption, not a check's refusal (BR-2067)
    const other = ws(root, "agent:b");
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b).mine).toBe(true);
  }, TIMED);

  test("BR-2018: a --finish lander killed by SIGTERM takes its close commit back", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"sleep 30\"\ntests: []\n");
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed finish");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const logs = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs");
    await until(() => entryOf(root)?.state === "landing" && existsSync(join(logs, `land-${entryOf(root)!.id}.log`)));
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
  });

  test("BR-2099: a process group killed in the middle of the rebase leaves the worktree on its own commits, not mid-rebase", async () => {
    const root = project();
    const s = startNew(root, "Killed mid-rebase");
    writeFileSync(join(s.worktree, "mine.txt"), "mine\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const before = sh(s.worktree, "rev-parse", "HEAD");
    writeFileSync(join(root, "theirs.txt"), "theirs\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "main moved"); // so the rebase has work to do
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, "..", `${root.split("/").pop()}-in-rebase`);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${marker}\nsleep 30\n`, { mode: 0o755 });
    // reason: a new process group, so the signal reaches git and the hook too, as a tool timeout's would.
    const p = Bun.spawn(["perl", "-e", "setpgrp(0,0); exec @ARGV", "bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await until(() => existsSync(marker));
    process.kill(-p.pid, "SIGTERM");
    expect(await p.exited).toBe(143);
    expect(existsSync(join(sh(s.worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge")))).toBe(false);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(before);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
  }, TIMED);
});

describe("queue wait", () => {
  test("BR-2122: a lander that gets its turn records land.turn with how long it waited", async () => {
    const root = project();
    const s = startNew(root, "Timed");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const turns = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.turn'").all().map((e) => JSON.parse(e.detail) as { waited_ms: number; entry: number });
    expect(turns.length).toBe(1);
    expect(turns[0]!.waited_ms).toBeGreaterThanOrEqual(0);
    expect(typeof turns[0]!.entry).toBe("number");
  });
});

describe("floor skip for landings that change only declared paths", () => {
  function skipProject(config: string) {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), config);
    sh(root, "commit", "-qam", "config");
    return root;
  }
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => JSON.parse(r.detail) as Record<string, unknown>);
  const commitFile = (wt: string, path: string, text: string) => {
    mkdirSync(join(wt, path, ".."), { recursive: true });
    writeFileSync(join(wt, path), text);
    sh(wt, "add", path);
    sh(wt, "commit", "-qm", path);
  };
  const SKIP = 'floor: "false"\ntests: []\nfloor_skip_paths: [canon/changes, canon/notes]\n';

  test("BR-2164: only declared paths changed: the floor is skipped, said and recorded, and the landing still lands", async () => {
    const root = skipProject(SKIP);
    const s = startNew(root, "Notes only");
    commitFile(s.worktree, "canon/notes/N-1.md", "---\nid: N-1\ntitle: 笔记\n---\n\n内容。\n");
    const said: string[] = [];
    const out = await land(ws(s.worktree), FAST, (m) => said.push(m));
    expect(out.kind).toBe("landed");
    expect(said.some((m) => m.startsWith("floor: skipped") && m.includes("canon/changes, canon/notes"))).toBe(true);
    const skip = events(root, "floor.skip");
    expect(skip.length).toBe(1);
    expect(skip[0]!["paths"]).toEqual([`canon/changes/${s.change}-notes-only.md`, "canon/notes/N-1.md"]);
    expect(events(root, "land.ok")[0]!["floor_skipped"]).toBe(true);
  });

  test("BR-2164: a path outside the entries, a sibling with the same prefix, a test file, or no entries at all runs the floor", async () => {
    const outside = skipProject(SKIP);
    const a = startNew(outside, "Code too");
    commitFile(a.worktree, "app.txt", "changed\n");
    const r1 = await land(ws(a.worktree), FAST, quiet);
    expect(r1.kind === "refused" && r1.reason).toBe("floor");

    const sibling = skipProject(SKIP);
    const b = startNew(sibling, "Sibling");
    commitFile(b.worktree, "canon/notesx/a.md", "x\n");
    const r2 = await land(ws(b.worktree), FAST, quiet);
    expect(r2.kind === "refused" && r2.reason).toBe("floor");

    const tests = skipProject('floor: "false"\ntests: ["docs/**/*.test.ts"]\nfloor_skip_paths: [canon/changes, docs]\n');
    const c = startNew(tests, "Test file");
    commitFile(c.worktree, "docs/a.test.ts", "// a test\n");
    const r3 = await land(ws(c.worktree), FAST, quiet);
    expect(r3.kind === "refused" && r3.reason).toBe("floor");

    const unset = skipProject('floor: "false"\ntests: []\n');
    const d = startNew(unset, "No entries");
    const r4 = await land(ws(d.worktree), FAST, quiet);
    expect(r4.kind === "refused" && r4.reason).toBe("floor");
    for (const root of [outside, sibling, tests, unset]) expect(events(root, "floor.skip")).toEqual([]);
  });

  test("BR-2164: canon check still refuses after a skipped floor, marked floor_skipped, and stats count no floor run", async () => {
    const root = skipProject(SKIP);
    const s = startNew(root, "Dangling");
    commitFile(s.worktree, "canon/notes/N-1.md", `---\nid: N-1\ntitle: 笔记\n---\n\n见 ${["D", 99].join("-")}。\n`);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(events(root, "land.refuse")[0]!["floor_skipped"]).toBe(true);
    const { computeStats } = await import("../stats/stats.ts");
    const stats = computeStats(ws(root).db, {}, "2026-11-03");
    expect(stats.find((x) => x.check === "floor")!.runs).toBe(0);
    expect(stats.find((x) => x.check === "check")!.runs).toBe(1);
  });
});

describe("batched landings", () => {
  function batchProject(extra = "land_batch_max: 3\n") {
    const root = project();
    const dir = join(root, "..", `${root.split("/").pop()}-floor`);
    mkdirSync(dir, { recursive: true });
    const runs = join(dir, "runs");
    const sneak = join(dir, "sneak");
    writeFileSync(join(dir, "floor.sh"), `echo run >> ${runs}\nif [ -f ${sneak} ]; then git -C "$(cat ${sneak})" commit -q --allow-empty -m sneaky; rm ${sneak}; fi\ntest ! -e FAIL\n`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\n${extra}`);
    sh(root, "commit", "-qam", "config");
    const floorRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").length : 0);
    return { root, floorRuns, sneak };
  }
  const commitFile = (wt: string, path: string, text: string) => {
    writeFileSync(join(wt, path), text);
    sh(wt, "add", path);
    sh(wt, "commit", "-qm", path);
  };
  /** Lands the worktrees together: all queue behind a silent entry, which then finishes, so the first leads. */
  async function landTogether(root: string, worktrees: readonly string[], opts = FAST) {
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const said: string[][] = worktrees.map(() => []);
    const runs: Promise<Awaited<ReturnType<typeof land>>>[] = [];
    for (const [i, wt] of worktrees.entries()) {
      runs.push(land(ws(wt), opts, (m) => said[i]!.push(m)));
      for (let n = 0; n < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(wt); n++) await Bun.sleep(10);
    }
    finishEntry(other.db, blocker, "landed", "x");
    return { out: await Promise.all(runs), said };
  }
  const landOks = (root: string) =>
    ws(root).db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'land.ok' ORDER BY id").all().map((r) => ({ ...(JSON.parse(r.detail) as Record<string, unknown>), subject: r.subject }) as Record<string, unknown>);

  test("BR-2172: landings waiting behind the leader are tested with it under one floor run, keep their own commits and land in order", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree], { ...FAST, finish: true });
    expect(out.map((o) => o.kind === "landed" && o.finished)).toEqual([true, true]);
    expect(floorRuns()).toBe(1);
    for (const c of [a.change, b.change]) expect(sh(root, "show", `main:canon/changes/${c}-${c === a.change ? "a" : "b"}.md`)).toContain("status: done");
    expect(claims(ws(root).db).filter((c) => c.subject === a.change || c.subject === b.change)).toEqual([]);
    const main = sh(root, "rev-parse", "main");
    expect(out[1]!.kind === "landed" && out[1]!.sha).toBe(main);
    expect(out[0]!.kind === "landed" && sh(root, "merge-base", "--is-ancestor", out[0]!.sha, main)).toBe("");
    expect(sh(root, "log", "--format=%s", "main").split("\n").slice(0, 3)).toEqual([`canon: close ${b.change}`, "b.txt", `canon: open ${b.change} B`]);
    expect(sh(b.worktree, "rev-parse", "HEAD")).toBe(main); // the member's branch follows its landed commit
    expect(existsSync(join(b.worktree, "a.txt"))).toBe(true);
    expect(said[0]!.some((m) => m.startsWith(`batch: testing ${b.change} together with ${a.change}`))).toBe(true);
    const oks = landOks(root);
    expect(oks.map((o) => o.subject)).toEqual([a.change, b.change]);
    expect(oks[1]!["batched_by"]).toBeNumber();
    const { computeStats } = await import("../stats/stats.ts");
    expect(computeStats(ws(root).db, {}, "2026-11-03").find((x) => x.check === "floor")!.runs).toBe(1);
  }, TIMED);

  test("BR-2173: a batch whose floor fails falls back: the good change lands alone, the bad one is refused on its own floor", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "Good");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "Bad");
    commitFile(b.worktree, "FAIL", "x\n");
    const { out, said } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out[0]!.kind).toBe("landed");
    expect(out[1]!.kind === "refused" && out[1]!.reason).toBe("floor");
    expect(floorRuns()).toBe(3); // the batch, then each alone
    expect(existsSync(join(root, "FAIL"))).toBe(false);
    expect(sh(root, "show", "main:a.txt")).toBe("a");
    expect(said[0]!.some((m) => m.includes("go back to the queue to land on their own"))).toBe(true);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'batch.fail'").get()?.n).toBe(1);
  }, TIMED);

  test("BR-2173: a member whose worktree changes during the batch makes it fall back; both then land alone", async () => {
    const { root, floorRuns, sneak } = batchProject();
    const a = startNew(root, "A");
    commitFile(a.worktree, "a.txt", "a\n");
    const b = startNew(root, "B");
    commitFile(b.worktree, "b.txt", "b\n");
    writeFileSync(sneak, b.worktree);
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(floorRuns()).toBe(3);
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("sneaky");
  }, TIMED);

  test("BR-2172: a member that does not rebase onto the batch is left out and lands on its own turn; land_batch_max 1 never batches", async () => {
    const { root, floorRuns } = batchProject();
    const a = startNew(root, "One");
    commitFile(a.worktree, "app.txt", "one\nTWO\nthree\n");
    const b = startNew(root, "Two");
    commitFile(b.worktree, "app.txt", "one\n2\nthree\n");
    const { out } = await landTogether(root, [a.worktree, b.worktree]);
    expect(out[0]!.kind).toBe("landed");
    expect(out[1]!.kind === "refused" && out[1]!.reason).toBe("conflict");
    expect(floorRuns()).toBe(1);

    const single = batchProject("");
    const c = startNew(single.root, "C");
    commitFile(c.worktree, "c.txt", "c\n");
    const d = startNew(single.root, "D");
    commitFile(d.worktree, "d.txt", "d\n");
    const both = await landTogether(single.root, [c.worktree, d.worktree]);
    expect(both.out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(single.floorRuns()).toBe(2);
  }, TIMED);
});
