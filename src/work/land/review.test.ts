import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

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

  test("BR-2143 BR-2231: with instructions configured, only the listed files trigger the review; code alone and deletions never do; a listed file cannot be deleted while listed", async () => {
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
    const gone = startNew(root, "Delete the listed file");
    sh(gone.worktree, "rm", "-q", "docs/agent.md");
    sh(gone.worktree, "commit", "-qm", "delete");
    const refused = await land(ws(gone.worktree), FAST, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("check"); // still listed in instructions (BR-2231)
    // reason: a listed instruction file cannot be deleted while still listed (BR-2231), so the deletion is a skill's
    const d = startNew(root, "Delete a skill");
    sh(d.worktree, "rm", "-q", ".claude/skills/x/SKILL.md");
    sh(d.worktree, "commit", "-qm", "delete");
    expect((await land(ws(d.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    const b = startNew(root, "Edit the listed file");
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
