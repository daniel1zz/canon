import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { reviewSettingsOn } from "../../work/land/checks/review-scope.ts";
import { HANG_SECONDS, FAST, waitFor, project, quiet, sh, startNew, ws, landingProcess } from "../../work/testkit.ts";
import { runLandedReviews } from "./landed-queue.ts";
import { openFindings, recordFindings } from "./findings/findings.ts";

const CLI = join(import.meta.dir, "../../invocation/main.ts");

/** Lands `wt`, then runs the reviews queued after it in this process (BR-2441): the landing's outcome and lines, and what the reviews said. */
async function landReviewed(root: string, wt: string, guide?: string) {
  const lines: string[] = [];
  const out = await land(ws(wt), FAST, (l) => lines.push(l));
  const said: string[] = [];
  const r = await runLandedReviews(ws(root), (l) => said.push(l), guide);
  if (!r.ok) throw new Error(r.error.message);
  return { out, landing: lines.join("\n"), review: said.join("\n") };
}
const kinds = (root: string) => ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'review.%' ORDER BY id").all().map((e) => e.kind);
const lastReview = (root: string) => {
  const row = ws(root).db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind IN ('review.ok', 'review.block') ORDER BY id DESC LIMIT 1").get();
  return row ? { kind: row.kind, detail: JSON.parse(row.detail) as Record<string, unknown> } : undefined;
};

describe("rule review after landing", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return { root, promptFile };
  }

  test("BR-2009 BR-2036: a block verdict on changed rule text does not refuse the landing; the review after it saw the whole domain and the index of every rule", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).not.toBe(before);
    expect(r.landing).toContain("are reviewed after the landing, in the background");
    expect(r.review).toContain("is vague");
    expect(kinds(root)).toEqual(["review.block"]);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Domain: billing");
    expect(prompt).toContain(`- ${id} [billing] Refunds`);
    expect(prompt).toContain("language the documents are written in");
    expect(prompt).toContain("One rule is one trigger"); // the split criterion of D-5
  });

  describe("the architecture overview as review input (D-65)", () => {
    const OVERVIEW = "canon/architecture.md";
    const withOverview = (body: string) => `---\ntitle: 架构总览\n---\n# 架构总览\n\n${body}`;
    const rule = (text: string) => `---\nid: ${["BR", 1].join("-")}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;
    function overviewProject(body: string | undefined) {
      const { root, promptFile } = reviewedProject("ok");
      if (body !== undefined) writeFileSync(join(root, OVERVIEW), withOverview(body));
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "overview", "--allow-empty");
      return { root, promptFile };
    }

    test("BR-2009: a landing that changes a rule gets the overview in the review's context, marked as not changed; the prompt says the rules win and only its changed text can block", async () => {
      const { root, promptFile } = overviewProject("## 容器\n\n- 账单：`src/billing`。\n");
      const s = startNew(root, "New rule");
      writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), rule("Refunds are paid in 30 days."));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "rule");
      expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("# Architecture overview (canon/architecture.md, not changed in this landing)");
      expect(prompt).toContain("- 账单：`src/billing`。");
      expect(prompt).toContain("Use this key only when the part of the overview this landing changed");
      expect(prompt).not.toContain("## Diff of the overview in this landing");
    });

    test("BR-2009: a landing that changes a rule and the overview shows the reviewer the overview's diff; a block lands all the same and is a review.block", async () => {
      const { root, promptFile } = overviewProject("## 容器\n\n- 账单：`src/billing`。\n");
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"block","findings":["no"]}'''\n`);
      sh(root, "commit", "-qam", "blocking reviewer");
      const s = startNew(root, "Rule and overview");
      writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), rule("Refunds are paid in 30 days."));
      writeFileSync(join(s.worktree, OVERVIEW), withOverview("## 容器\n\n- 账单：`src/billing`，退款 30 天内到账。\n"));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "rule and overview");
      expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("changed in this landing; the diff follows the text");
      expect(prompt).toContain("## Diff of the overview in this landing");
      expect(prompt).toContain("+- 账单：`src/billing`，退款 30 天内到账。");
      expect(kinds(root)).toEqual(["review.block"]);
    });

    test("BR-2009: with only headings, or no overview at all, the prompt has no overview section", async () => {
      for (const body of ["", undefined]) {
        const { root, promptFile } = overviewProject(body);
        const s = startNew(root, "New rule");
        writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), rule("Refunds are paid in 30 days."));
        sh(s.worktree, "add", "-A");
        sh(s.worktree, "commit", "-qm", "rule");
        expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
        expect(readFileSync(promptFile, "utf8")).not.toContain("# Architecture overview");
      }
    });

    test("BR-2009: a landing that changes only the overview is not reviewed", async () => {
      const { root, promptFile } = overviewProject("## 容器\n\n- 账单。\n");
      const s = startNew(root, "Overview only");
      writeFileSync(join(s.worktree, OVERVIEW), withOverview("## 容器\n\n- 账单：`src/billing`。\n"));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "overview");
      const r = await landReviewed(root, s.worktree);
      expect(r.out.kind).toBe("landed");
      expect(r.landing).not.toContain("reviewed after the landing");
      expect(existsSync(promptFile)).toBe(false);
    });
  });

  test("BR-2009 BR-2216: a reviewer that fails to run fails the review, not the landing, and the log says its directory holds only committed files", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), "");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const base = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(r.review).toContain("could not run");
    expect(r.review).toContain("git-ignored files such as node_modules");
    expect(r.review).toContain(`temporary worktree at the commit main was on before the landing ${base.trim().slice(0, 9)}`);
    expect(r.review).toContain(`${sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()}/canon/review/`);
    expect(kinds(root)).toEqual(["review.fail"]);
  });

  /** A project with the billing domain on main and canon/config.yaml set to `config` (no review key when it has none). */
  function billingProject(config: string) {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), config);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return root;
  }
  const skips = (root: string) => ws(root).db.db.query<{ reason: string }, []>("SELECT json_extract(detail, '$.reason') AS reason FROM events WHERE kind = 'review.skip'").all().map((r) => r.reason);
  const queued = (root: string) => ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM landed_reviews").get()!.n;
  const id = ["BR", 1].join("-");
  const addRule = (wt: string) => {
    writeFileSync(join(wt, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "rule");
  };

  /** An executable reviewer script that saves its prompt and answers `verdict` (or runs `body` instead); returns its path and the prompt file. */
  function reviewer(root: string, body?: string, name = "review") {
    const script = join(root, "..", `${root.split("/").pop()}-${name}.sh`);
    const promptFile = `${script}.prompt`;
    writeFileSync(script, `#!/bin/sh\n${body ?? `cat > ${promptFile}\necho '{"verdict":"ok","findings":[]}'`}\n`);
    chmodSync(script, 0o755);
    return { script, promptFile };
  }
  /** Commits canon/config.yaml on main directly, as a landing that only changes it would. */
  const configOnMain = (root: string, config: string) => {
    writeFileSync(join(root, "canon/config.yaml"), config);
    sh(root, "commit", "-qam", "config");
  };
  /** Whether process `pid` is gone, waiting up to 3 s for it to be reaped. */
  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await Bun.sleep(100);
    }
    return false;
  }

  test("BR-2074 BR-2022: changed rule text with no review key lands, says it landed without a review, the reviewer command first and review: none as the owner's call; nothing is queued", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", ...landingProcess() } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    const said = `${out}${err}`;
    expect(said).toContain(`${id} landed without a review`);
    expect(said).toContain("acceptance fails until they are reviewed");
    expect(said.indexOf('review: "claude -p --model sonnet --output-format text"')).toBeGreaterThan(-1);
    expect(said.indexOf('review: "claude -p --model sonnet --output-format text"')).toBeLessThan(said.indexOf("review: none"));
    expect(said).toContain("canon human ask");
    expect(skips(root)).toEqual(["unconfigured"]);
    expect(queued(root)).toBe(0);
    expect(sh(root, "rev-parse", "main")).not.toBe(before);
  }, 30_000);

  test("BR-2074: a deleted decision with review set empty or blank lands unreviewed too; with no review key, code and change files alone land with no review.skip", async () => {
    for (const blank of ['""', '"   "']) {
      const root = billingProject(`floor: "true"\ntests: []\nreview: ${blank}\n`);
      const d = ["D", 1].join("-");
      mkdirSync(join(root, "canon/decisions"), { recursive: true });
      writeFileSync(join(root, `canon/decisions/${d}.md`), `---\nid: ${d}\ntitle: Old\nstatus: proposed\n---\n\n## 背景\n\nx\n`);
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "decision");
      const s = startNew(root, "Drop decision");
      sh(s.worktree, "rm", "-q", `canon/decisions/${d}.md`);
      sh(s.worktree, "commit", "-qm", "drop");
      const r = await landReviewed(root, s.worktree);
      expect(r.out.kind).toBe("landed");
      expect(r.landing).toContain(`${d} (deleted) landed without a review`);
      expect(skips(root)).toEqual(["unconfigured"]);
    }
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const code = startNew(root, "Code only");
    writeFileSync(join(code.worktree, "src/billing/a.ts"), "export const a = 1;\n");
    sh(code.worktree, "add", "-A");
    sh(code.worktree, "commit", "-qm", "code");
    expect((await landReviewed(root, code.worktree)).out.kind).toBe("landed");
    expect(skips(root)).toEqual([]);
  });

  test("BR-2074: a new release document with no review key lands unreviewed, naming the release", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const s = startNew(root, "A release");
    mkdirSync(join(s.worktree, "canon/releases"), { recursive: true });
    const r = ["R", 1].join("-");
    writeFileSync(join(s.worktree, `canon/releases/${r}.md`), `---\nid: ${r}\ntitle: MVP\n---\n\n${["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"].map((h) => `## ${h}\n\n内容\n`).join("\n")}`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "release");
    const out = await landReviewed(root, s.worktree);
    expect(out.out.kind).toBe("landed");
    expect(out.landing).toContain(`${r} landed without a review`);
  });

  test("BR-2074: with review: none changed rule text lands with a review: none line and a review.skip event", async () => {
    const root = billingProject(`floor: "true"\ntests: []\nreview: none\n`);
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(r.landing).toContain(`review: none — ${id} landed without a review`);
    expect(skips(root)).toEqual(["none"]);
    expect(queued(root)).toBe(0);
  });

  test("BR-2074: main decides: main turned the review on after the worktree started with none, and the rule is reviewed", async () => {
    const root = billingProject(`floor: "true"\ntests: []\nreview: none\n`);
    const s = startNew(root, "New rule");
    const r = reviewer(root);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    addRule(s.worktree);
    expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
    expect(readFileSync(r.promptFile, "utf8")).toContain(id);
    expect(skips(root)).toEqual([]);
  });

  test("BR-2074: turning the review off or removing it in the landing that changes a rule lands, and the rule is still reviewed by main's command", async () => {
    for (const next of ["review: none\n", ""]) {
      const root = billingProject(`floor: "true"\ntests: []\n`);
      const r = reviewer(root);
      configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
      const s = startNew(root, "Off and rule");
      writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\n${next}`);
      addRule(s.worktree);
      expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
      expect(readFileSync(r.promptFile, "utf8")).toContain(id);
      expect(skips(root)).toEqual([]);
    }
  });

  test("BR-2216: a reviewer that reads a git-ignored .env cannot find it and the log says why; a block verdict carries no such line", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    writeFileSync(join(root, ".gitignore"), ".env\n");
    writeFileSync(join(root, ".env"), "KEY=1\n");
    sh(root, "add", ".gitignore");
    sh(root, "commit", "-qm", "ignore env");
    const needsEnv = reviewer(root, `cat > /dev/null\ncat .env > /dev/null || exit 3\necho '{"verdict":"ok","findings":[]}'`, "env");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(needsEnv.script)}\n`);
    const s = startNew(root, "Rule needing env");
    writeFileSync(join(s.worktree, ".env"), "KEY=1\n");
    addRule(s.worktree);
    const r = await landReviewed(root, s.worktree);
    expect(r.review).toContain("could not run");
    expect(r.review).toContain("git-ignored files such as node_modules");
    const strict = reviewer(root, `cat > /dev/null\necho '{"verdict":"block","findings":["vague"]}'`, "strict");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const t = startNew(root, "Another rule");
    writeFileSync(join(t.worktree, "canon/rules/billing/BR-2.md"), `---\nid: BR-2\ntitle: Fees\nuntested: demo\nbusiness: x\n---\n## 规则\n\nFees are fine.\n`);
    sh(t.worktree, "add", "-A");
    sh(t.worktree, "commit", "-qm", "rule 2");
    const blocked = await landReviewed(root, t.worktree);
    expect(blocked.review).toContain("old answer format with no criterion, so not recorded as an open finding): vague");
    expect(blocked.review).not.toContain("git-ignored");
  });

  test("BR-2074: a change that swaps the reviewer for one that always answers ok is still reviewed by main's command (#115)", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const strict = reviewer(root, `cat > /dev/null\necho '{"verdict":"block","findings":["${id} is vague"]}'`, "strict");
    const lenient = reviewer(root, undefined, "lenient");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const s = startNew(root, "Swap and rule");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(lenient.script)}\n`);
    addRule(s.worktree);
    const r = await landReviewed(root, s.worktree);
    expect(r.review).toContain(`${id} is vague`);
    expect(kinds(root)).toEqual(["review.block"]);
    expect(existsSync(lenient.promptFile)).toBe(false); // the change's own reviewer never ran
  });

  test("BR-2367: a finding that names a blocking criterion makes the review a block even when the answer says ok; findings that are all notes are an ok", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const flawed = reviewer(root, `cat > /dev/null\necho '{"verdict":"ok","findings":[{"criterion":"contradiction","text":"${id} contradicts BR-9"}]}'`, "flawed");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(flawed.script)}\n`);
    const s = startNew(root, "Rule with a flaw");
    addRule(s.worktree);
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(r.review).toContain(`[contradiction] ${id} contradicts BR-9`);
    expect(kinds(root)).toEqual(["review.block"]);

    const notes = reviewer(root, `cat > /dev/null\necho '{"findings":[{"criterion":"note","text":"BR-2 could be shorter"}]}'`, "notes");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(notes.script)}\n`);
    const t = startNew(root, "Another rule");
    writeFileSync(join(t.worktree, "canon/rules/billing/BR-2.md"), `---\nid: BR-2\ntitle: Fees\nuntested: demo\nbusiness: x\n---\n## 规则\n\nFees are fine.\n`);
    sh(t.worktree, "add", "-A");
    sh(t.worktree, "commit", "-qm", "rule 2");
    const ok = await landReviewed(root, t.worktree);
    expect(ok.review).toContain("review note: BR-2 could be shorter");
    expect(kinds(root)).toEqual(["review.block", "review.ok"]);
  });

  test("BR-2367: the duplicate review of standing instructions derives its verdict the same way", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const strict = reviewer(root, `cat > /dev/null\necho '{"verdict":"ok","findings":[{"criterion":"duplication","text":"stated twice"}]}'`, "dup");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    sh(root, "add", "-A");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const s = startNew(root, "Edit instructions");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "edit");
    const r = await landReviewed(root, s.worktree);
    expect(r.review).toContain("[duplication] stated twice");
    expect(lastReview(root)?.kind).toBe("review.block");
    expect(lastReview(root)?.detail["review"]).toBe("duplicate");
  });

  test("BR-2074: with no reviewer on main, a change that sets one and changes a rule lands unreviewed and its own reviewer never runs; the next rule is reviewed by it", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const r = reviewer(root);
    const both = startNew(root, "Reviewer and rule");
    writeFileSync(join(both.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    addRule(both.worktree);
    const first = await landReviewed(root, both.worktree);
    expect(first.out.kind).toBe("landed");
    expect(first.landing).toContain(`${id} landed without a review`);
    expect(existsSync(r.promptFile)).toBe(false);
    const later = startNew(root, "Rule after");
    writeFileSync(join(later.worktree, "canon/rules/billing/BR-2.md"), `---\nid: BR-2\ntitle: Fees\nuntested: demo\nbusiness: x\n---\n## 规则\n\nFees are fine.\n`);
    sh(later.worktree, "add", "-A");
    sh(later.worktree, "commit", "-qm", "rule 2");
    expect((await landReviewed(root, later.worktree)).out.kind).toBe("landed");
    expect(readFileSync(r.promptFile, "utf8")).toContain("BR-2");
  });

  test("BR-2143: with no reviewer on main, a change that sets one and edits CLAUDE.md lands and its own reviewer is never called (#115)", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "claude");
    const r = reviewer(root);
    const s = startNew(root, "Reviewer and CLAUDE.md");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const out = await landReviewed(root, s.worktree);
    expect(out.out.kind).toBe("landed");
    expect(out.landing).toContain("CLAUDE.md landed without a review");
    expect(existsSync(r.promptFile)).toBe(false);
  });

  test("BR-2143: a change that edits CLAUDE.md and drops it from instructions is still reviewed by main's list (#115)", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const strict = reviewer(root, `cat > /dev/null\necho '{"findings":[{"criterion":"duplication","text":"stated twice"}]}'`, "strict");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/other.md"), "# Other\n"); // on main and untouched: listing it alone reviews nothing here
    sh(root, "add", "-A");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const s = startNew(root, "Drop and edit");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\ninstructions: [docs/other.md]\n`);
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "drop and edit");
    const r = await landReviewed(root, s.worktree);
    expect(r.review).toContain("review: standing instructions CLAUDE.md");
    expect(r.review).toContain("[duplication] stated twice");
  });

  /** The review worktrees git still lists for `root`: the temporary ones sit under canon's state directory, in a `review` folder. */
  const reviewTrees = (root: string) => sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes("/review/"));

  test("BR-2216: the reviewer runs in one temporary worktree at main's commit before the landing for both reviews: that commit's script, CLAUDE.md, settings and skills, never the change's; it is gone afterwards", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const out = join(root, "..", `${root.split("/").pop()}-probe`);
    mkdirSync(out, { recursive: true });
    const body = (tag: string) => `#!/bin/sh\n{ echo "${tag}"; pwd -P; cat CLAUDE.md; cat .claude/settings.json; ls .claude/skills; } >> ${out}/seen.txt\ncat >> ${out}/prompts.txt\necho '{"verdict":"${tag === "main-script" ? "ok" : "block"}","findings":["changed script ran"]}'\n`;
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/review.sh"), body("main-script"));
    chmodSync(join(root, "scripts/review.sh"), 0o755);
    writeFileSync(join(root, "CLAUDE.md"), "main claude\n");
    mkdirSync(join(root, ".claude/skills/old"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), '{"main":true}\n');
    writeFileSync(join(root, ".claude/skills/old/SKILL.md"), "---\nname: old\ndescription: Use when old.\n---\nold\n");
    sh(root, "add", "-A");
    configOnMain(root, `floor: "true"\ntests: []\nreview: scripts/review.sh\n`);
    // the primary checkout is on another branch and dirty: the review runs the same
    sh(root, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
    const s = startNew(root, "Rule and instructions");
    const mainSha = sh(root, "rev-parse", "main");
    writeFileSync(join(s.worktree, "scripts/review.sh"), body("changed-script"));
    writeFileSync(join(s.worktree, "CLAUDE.md"), "changed claude\n");
    writeFileSync(join(s.worktree, ".claude/settings.json"), '{"changed":true}\n');
    mkdirSync(join(s.worktree, ".claude/skills/new"), { recursive: true });
    writeFileSync(join(s.worktree, ".claude/skills/new/SKILL.md"), "---\nname: new\ndescription: Use when new.\n---\nnew\n");
    addRule(s.worktree);
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    const seen = readFileSync(join(out, "seen.txt"), "utf8");
    expect(seen.match(/main-script/g)?.length).toBe(2); // the rule review and the duplicate review, both main's script
    expect(seen).not.toContain("changed-script");
    expect(seen).not.toContain("changed claude");
    expect(seen).not.toContain('"changed"');
    expect(seen).toContain("main claude");
    expect(seen).toContain('{"main":true}');
    expect(seen).toMatch(/^old$/m);
    expect(seen).not.toMatch(/^new$/m);
    // the reviewer's directory has only main's skills, so the changed skill's new text reaches it through the prompt (#122)
    expect(readFileSync(join(out, "prompts.txt"), "utf8")).toContain("# .claude/skills/new/SKILL.md (changed in this landing, full new text)");
    const cwds = [...seen.matchAll(/^main-script\n(.*)$/gm)].map((m) => m[1]!);
    expect(cwds[0]).toBe(cwds[1]); // one temporary worktree for both
    expect(cwds[0]).toContain("/review/");
    expect(cwds[0]).not.toBe(realpathSync(s.worktree));
    expect(existsSync(cwds[0]!)).toBe(false);
    expect(reviewTrees(root)).toEqual([]);
    expect(mainSha).not.toBe(sh(root, "rev-parse", "main")); // it landed
  });

  test("BR-2216: after ok, block, a failing command, an invalid verdict and a timeout the temporary worktrees are gone, and no review is queued when nothing needs one", async () => {
    const cases: { name: string; body: string; config?: string; failed: boolean }[] = [
      { name: "ok", body: `echo '{"verdict":"ok","findings":[]}'`, failed: false },
      { name: "block", body: `echo '{"verdict":"block","findings":["no"]}'`, failed: false },
      { name: "exit", body: "exit 3", failed: true },
      { name: "invalid", body: "echo nothing", failed: true },
      { name: "timeout", body: `exec sleep ${HANG_SECONDS}`, config: "review_timeout_minutes: 0.05\n", failed: true },
    ];
    for (const c of cases) {
      const root = billingProject(`floor: "true"\ntests: []\n`);
      const where = join(root, "..", `${root.split("/").pop()}-cwd.txt`);
      const r = reviewer(root, `pwd -P > ${where}\ncat > /dev/null\n${c.body}`, c.name);
      configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n${c.config ?? ""}`);
      const s = startNew(root, "New rule");
      addRule(s.worktree);
      const out = await landReviewed(root, s.worktree);
      expect([c.name, out.out.kind]).toEqual([c.name, "landed"]);
      expect([c.name, out.review.includes("could not run")]).toEqual([c.name, c.failed]);
      expect([c.name, existsSync(where)]).toEqual([c.name, true]);
      const dir = readFileSync(where, "utf8").trim();
      expect(dir).toContain("/review/");
      expect(existsSync(dir)).toBe(false);
      expect(reviewTrees(root)).toEqual([]);
    }
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const r = reviewer(root);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const code = startNew(root, "Code only");
    writeFileSync(join(code.worktree, "src/billing/a.ts"), "export const a = 1;\n");
    sh(code.worktree, "add", "-A");
    sh(code.worktree, "commit", "-qm", "code");
    expect((await landReviewed(root, code.worktree)).out.kind).toBe("landed");
    expect(queued(root)).toBe(0);
    expect(existsSync(r.promptFile)).toBe(false);
  }, 60_000);

  test("BR-2296 BR-2441: a reviewer past review_timeout_minutes is stopped with its children and the review fails, not the landing; main's limit applies", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const pidFile = join(root, "..", `${root.split("/").pop()}-child.pid`);
    const r = reviewer(root, `sleep ${HANG_SECONDS} &\necho $! > ${pidFile}\nwait`);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\nreview_timeout_minutes: 0.1\n`);
    const s = startNew(root, "New rule");
    // the change's own longer limit does not apply to the review of its own landing: main's 6 s does (BR-2074, #115)
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\nreview_timeout_minutes: 60\n`);
    addRule(s.worktree);
    const started = Date.now();
    const out = await landReviewed(root, s.worktree);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(out.out.kind).toBe("landed");
    expect(out.review).toContain("did not finish within");
    expect(kinds(root)).toEqual(["review.fail"]);
    expect(await gone(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  }, 75_000);

  test("BR-2074 BR-2359: review_max_prompt_kb comes from main: the change's own larger budget does not lift main's, and its smaller one does not lower it", async () => {
    const tight = billingProject(`floor: "true"\ntests: []\n`);
    const r1 = reviewer(tight);
    configOnMain(tight, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r1.script)}\nreview_max_prompt_kb: 1\n`);
    const s1 = startNew(tight, "New rule");
    writeFileSync(join(s1.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r1.script)}\nreview_max_prompt_kb: 10000\n`);
    addRule(s1.worktree);
    const out1 = await landReviewed(tight, s1.worktree);
    expect(out1.out.kind).toBe("landed");
    expect(out1.review).toContain("above review_max_prompt_kb = 1 KB");
    expect(existsSync(r1.promptFile)).toBe(false); // failed before the reviewer ran

    const roomy = billingProject(`floor: "true"\ntests: []\n`);
    const r2 = reviewer(roomy);
    configOnMain(roomy, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r2.script)}\nreview_max_prompt_kb: 10000\n`);
    const s2 = startNew(roomy, "New rule");
    writeFileSync(join(s2.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r2.script)}\nreview_max_prompt_kb: 1\n`);
    addRule(s2.worktree);
    expect((await landReviewed(roomy, s2.worktree)).review).toContain("review: done");
    expect(existsSync(r2.promptFile)).toBe(true);
  }, 60_000);

  test("BR-2074 BR-2359: review_parallel comes from main, not from the change's own config; 4 when main does not set it", () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const s = startNew(root, "Parallel");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview_parallel: 9\n`);
    sh(s.worktree, "commit", "-qam", "own config");
    const unset = reviewSettingsOn(s.worktree, "main");
    expect(unset.ok && unset.value.reviewParallel).toBe(4);
    configOnMain(root, `floor: "true"\ntests: []\nreview_parallel: 3\n`);
    const set = reviewSettingsOn(s.worktree, "main");
    expect(set.ok && set.value.reviewParallel).toBe(3);
  });

  test("BR-2296 BR-2441: canon work review-landed stopped by SIGTERM while the reviewer runs exits 143, stops the reviewer and removes its worktrees; the next one runs the review again", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const pidFile = join(root, "..", `${root.split("/").pop()}-reviewer.pid`);
    const marker = join(root, "..", `${root.split("/").pop()}-second`);
    const r = reviewer(root, `if [ -e ${marker} ]; then cat > /dev/null; echo '{"findings":[]}'; exit 0; fi\npwd -P > ${pidFile}.cwd\necho $$ > ${pidFile}\nexec sleep ${HANG_SECONDS}`);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const p = Bun.spawn(["bun", CLI, "work", "review-landed"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await waitFor("the reviewer to start", () => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const dir = readFileSync(`${pidFile}.cwd`, "utf8").trim();
    expect(existsSync(dir)).toBe(true); // while the review runs it is there
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(await gone(pid)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(reviewTrees(root)).toEqual([]);
    expect(ws(root).db.db.query<{ state: string }, []>("SELECT state FROM landed_reviews").get()?.state).toBe("running");
    writeFileSync(marker, "");
    const said: string[] = [];
    expect((await runLandedReviews(ws(root), (l) => said.push(l), undefined)).ok).toBe(true);
    expect(said.join("\n")).toContain("review: done");
    expect(ws(root).db.db.query<{ state: string }, []>("SELECT state FROM landed_reviews").get()?.state).toBe("done");
  }, 40_000);

  test("BR-2009: changing only a domain README is reviewed after the landing", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Readme only");
    writeFileSync(join(s.worktree, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nRules here are optional.\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    sh(s.worktree, "commit", "-qam", "readme");
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("Rules here are optional.");
    expect(kinds(root)).toEqual(["review.block"]);
  });

  test("BR-2009 BR-2010: a release document changed on its own is reviewed with its new text; a block is a review.block, an ok a review.ok", async () => {
    const release = (not: string) => `---\nid: ${["R", 1].join("-")}\ntitle: MVP\nstatus: active\n---\n\n${["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"].map((h) => `## ${h}\n\n${h === "不做" ? not : `${h}的内容`}\n`).join("\n")}`;
    for (const verdict of ["block", "ok"] as const) {
      const p = reviewedProject(verdict);
      const s = startNew(p.root, "A release");
      mkdirSync(join(s.worktree, "canon/releases"), { recursive: true });
      writeFileSync(join(s.worktree, `canon/releases/${["R", 1].join("-")}.md`), release("不做退款的部分退款"));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "release");
      expect((await landReviewed(p.root, s.worktree)).out.kind).toBe("landed");
      const prompt = readFileSync(p.promptFile, "utf8");
      expect(prompt).toContain("不做退款的部分退款");
      expect(prompt).toContain("# Changed documents (new text)");
      expect(kinds(p.root)).toEqual([`review.${verdict}`]);
    }
  });

  test("BR-2009: deleting a rule file is reviewed with the text it had on main", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds within 30 days.\n`);
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await landReviewed(root, seed.worktree)).out.kind).toBe("landed");
    const s = startNew(root, "Delete rule");
    sh(s.worktree, "rm", "-q", `canon/rules/billing/${id}.md`);
    sh(s.worktree, "commit", "-qm", "delete");
    expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/${id}.md`);
    expect(prompt).toContain("Refunds within 30 days.");
  });

  test("BR-2009: a rule file moved with identical content is not reviewed; moved and edited is reviewed as deleted plus added", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const text = `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds within 30 days.\n`;
    // reason: the subdomain is not what this case is about, and a domain a change adds would need a decision (BR-2446)
    mkdirSync(join(root, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "subdomain");
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), text);
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await landReviewed(root, seed.worktree)).out.kind).toBe("landed");
    rmSync(promptFile, { force: true });

    const move = startNew(root, "Move rule");
    sh(move.worktree, "mv", `canon/rules/billing/${id}.md`, `canon/rules/billing/refunds/${id}.md`);
    sh(move.worktree, "commit", "-qm", "move");
    const moved = await landReviewed(root, move.worktree);
    expect(moved.out.kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    expect(moved.landing).toContain("review: 1 file(s) only moved, not reviewed");

    const edit = startNew(root, "Move and edit");
    sh(edit.worktree, "mv", `canon/rules/billing/refunds/${id}.md`, `canon/rules/billing/${id}.md`);
    writeFileSync(join(edit.worktree, `canon/rules/billing/${id}.md`), text.replace("30", "31"));
    sh(edit.worktree, "commit", "-qam", "move and edit");
    expect((await landReviewed(root, edit.worktree)).out.kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Refunds within 31 days.");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/refunds/${id}.md`);
  });

  test("BR-2448: a landing whose changed rules do not fit one call is reviewed in parts after it, each call within review_max_prompt_kb, and the review is done", async () => {
    const r = billingProject(`floor: "true"\ntests: []\n`);
    const calls = join(r, "..", `${r.split("/").pop()}-calls`);
    const sizes = reviewer(r, `wc -c >> ${calls}\necho '{"findings":[]}'`, "sizes");
    configOnMain(r, `floor: "true"\ntests: []\nreview: ${JSON.stringify(sizes.script)}\nreview_max_prompt_kb: 80\n`);
    const s = startNew(r, "Three large rules");
    for (const n of [1, 2, 3]) writeFileSync(join(s.worktree, `canon/rules/billing/BR-${n}.md`), `---\nid: BR-${n}\ntitle: Large ${n}\nuntested: demo\nbusiness: x\n---\n## 规则\n\nLARGE-${n} ${"x".repeat(30 * 1024)}\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "large rules");
    const out = await landReviewed(r, s.worktree);
    expect(out.out.kind).toBe("landed");
    expect(out.review).toMatch(/review: the changed documents do not fit one call, so they are reviewed in [23] parts: 1: BR-1/);
    expect(out.review).toContain("review: done");
    const seen = readFileSync(calls, "utf8").trim().split("\n").map((l) => Number(l.trim()));
    expect(seen.length).toBeGreaterThan(1);
    for (const n of seen) expect(n).toBeLessThanOrEqual(80 * 1024);
    expect(lastReview(r)?.kind).toBe("review.ok");
  });

  test("BR-2010: the reviewer is not asked and nothing is queued when no rule or decision text changed", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Code only");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "code");
    expect((await landReviewed(root, s.worktree)).out.kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    expect(queued(root)).toBe(0);
  });

  describe("blocking findings go to the main agent (BR-2442, D-99)", () => {
    const BLOCK = `cat > /dev/null\necho '{"findings":[{"criterion":"contradiction","text":"${id} 和 BR-7 的「三天」矛盾"},{"criterion":"note","text":"${id} could be shorter"}]}'`;
    function blockingProject(script: string) {
      const root = billingProject(`floor: "true"\ntests: []\n`);
      writeFileSync(join(root, "canon/rules/billing/BR-7.md"), `---\nid: BR-7\ntitle: Overseas refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nOverseas refunds take three days.\n`);
      sh(root, "add", "-A");
      const r = reviewer(root, script, "blocking");
      configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
      return root;
    }

    test("BR-2442: every blocking finding is recorded as an open finding on the review event, each said in the log with how to close it; notes are not recorded", async () => {
      const root = blockingProject(BLOCK);
      const s = startNew(root, "Rule");
      addRule(s.worktree);
      const r = await landReviewed(root, s.worktree);
      expect(r.review).toContain(`review finding: [contradiction] ${id} 和 BR-7 的「三天」矛盾`);
      expect(r.review).toContain(`review note: ${id} could be shorter`);
      expect(r.review).toMatch(/1 blocking finding\(s\) recorded as open review findings \(#\d+\)/);
      expect(r.review).toContain("canon finding close <n> --fixed <commit>");
      expect(r.review).toContain('canon finding close <n> --spurious "<quote from a document it names>"');
      const open = openFindings(ws(root).db);
      expect(open.map((f) => [f.criterion, [...f.docs]])).toEqual([["contradiction", [id, "BR-7"]]]);
      const event = ws(root).db.db.query<{ id: number; detail: string }, []>("SELECT id, detail FROM events WHERE kind = 'review.block'").get()!;
      expect(open[0]!.event).toBe(event.id);
      expect(open[0]!.sha).toBe(sh(root, "rev-parse", "main"));
      expect(JSON.parse(event.detail)).not.toHaveProperty("verified");
    });

    test("BR-2442: two blocking findings, one already open under the same identity: one new record, both numbers in the log", async () => {
      const two = `cat > /dev/null\necho '{"findings":[{"criterion":"contradiction","text":"${id} 和 BR-7 的「三天」矛盾"},{"criterion":"untestable","text":"${id} 的「很快」无法测试"}]}'`;
      const root = blockingProject(two);
      const db = ws(root).db;
      const seeded = recordFindings(db, { findings: [{ criterion: "contradiction", text: `${id} 和 BR-7 的「三天」矛盾` }], reviewed: [id], change: null, event: db.event("agent:t", "review.block", null, {}), sha: null });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const s = startNew(root, "Rule");
      addRule(s.worktree);
      const r = await landReviewed(root, s.worktree);
      const all = openFindings(ws(root).db);
      expect(all).toHaveLength(2);
      for (const f of all) expect(r.review).toContain(`#${f.id}`);
    });

    test("BR-2442: a review with only notes records nothing and says no canon finding close", async () => {
      const root = blockingProject(`cat > /dev/null\necho '{"findings":[{"criterion":"note","text":"shorter"}]}'`);
      const s = startNew(root, "Rule");
      addRule(s.worktree);
      const r = await landReviewed(root, s.worktree);
      expect(openFindings(ws(root).db)).toEqual([]);
      expect(r.review).not.toContain("canon finding close");
      expect(lastReview(root)?.kind).toBe("review.ok");
    });
  });
});

describe("duplicate review of standing instructions after landing", () => {
  const GUIDE = "- Ask the human only about direction.";
  function standingProject(verdict: "ok" | "block", extra = "") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-standing.txt`);
    const finding = verdict === "block" ? '{"criterion":"duplication","text":"CLAUDE.md repeats the guide"}' : '{"criterion":"note","text":"CLAUDE.md repeats the guide"}';
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${extra}review: 'cat > ${promptFile}; echo ''{"findings":[${finding}]}'''\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, ".claude/skills/x"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing tests\n---\nbody\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "standing");
    return { root, promptFile };
  }

  test("BR-2143: a block on an edited CLAUDE.md lands all the same; the reviewer saw the new text, the guide and the skill descriptions, and the finding is recorded on CLAUDE.md", async () => {
    const { root, promptFile } = standingProject("block");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Only ask the human about direction.\n");
    sh(s.worktree, "commit", "-qam", "instructions");
    const r = await landReviewed(root, s.worktree, GUIDE);
    expect(r.out.kind).toBe("landed");
    expect(r.review).toContain("[duplication] CLAUDE.md repeats the guide");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Changed in this landing: CLAUDE.md");
    expect(prompt).toContain("Only ask the human about direction.");
    expect(prompt).toContain(GUIDE);
    expect(prompt).toContain(".claude/skills/x/SKILL.md: Use when writing tests");
    expect(openFindings(ws(root).db).map((f) => [...f.docs])).toEqual([["CLAUDE.md"]]);
  });

  test("BR-2143: the prompt carries the diff and tells the reviewer to block only duplication on added lines; an old duplicate with an unrelated edit is an ok with the finding as a note (#121)", async () => {
    const { root, promptFile } = standingProject("ok");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n\n- Ask the human about direction.\n- Ask the human only about direction.\n- Unrelated line.\n");
    sh(root, "commit", "-qam", "old duplicate");
    const s = startNew(root, "Edit unrelated line");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Ask the human about direction.\n- Ask the human only about direction.\n- Unrelated line, reworded.\n");
    sh(s.worktree, "commit", "-qam", "unrelated");
    const r = await landReviewed(root, s.worktree, GUIDE);
    expect(r.out.kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# CLAUDE.md (diff of this landing");
    expect(prompt).toContain("+- Unrelated line, reworded.");
    expect(prompt).toContain("-- Unrelated line.");
    expect(prompt).not.toContain("+- Ask the human only about direction.");
    expect(prompt).toContain("at least one of the two places is in a line this landing added or changed");
    expect(prompt).toContain("A moved line (removed in one place, added in another) counts as added");
    expect(prompt).toContain("do not block for it");
    expect(r.review).toContain("review note: CLAUDE.md repeats the guide");
  });

  test("BR-2143: a change that adds a line repeating a requirement stated elsewhere is shown to the reviewer as an added line (#121)", async () => {
    const { root, promptFile } = standingProject("block");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n\n- Ask the human about direction.\n");
    sh(root, "commit", "-qam", "one statement");
    const s = startNew(root, "Repeat a requirement");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Ask the human about direction.\n- Ask the human only about direction.\n");
    sh(s.worktree, "commit", "-qam", "repeat");
    expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("+- Ask the human only about direction.");
    expect(kinds(root)).toEqual(["review.block"]);
  });

  test("BR-2143: an edited skill is reviewed with its new full text in the prompt", async () => {
    const { root, promptFile } = standingProject("ok");
    const s = startNew(root, "Edit skill");
    writeFileSync(join(s.worktree, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing or reviewing tests\n---\nnew body line\n");
    sh(s.worktree, "commit", "-qam", "skill");
    expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("# Changed in this landing: .claude/skills/x/SKILL.md");
    // the reviewer runs in main's tree, so the changed body travels in the prompt, not from main's old file (#122)
    expect(readFileSync(promptFile, "utf8")).toContain("# .claude/skills/x/SKILL.md (changed in this landing, full new text)");
    expect(readFileSync(promptFile, "utf8")).toContain("new body line");
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
    expect((await landReviewed(root, a.worktree)).out.kind).toBe("landed");
    const gone = startNew(root, "Delete the listed file");
    sh(gone.worktree, "rm", "-q", "docs/agent.md");
    sh(gone.worktree, "commit", "-qm", "delete");
    const refused = await land(ws(gone.worktree), FAST, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("check"); // still listed in instructions (BR-2231)
    // reason: a listed instruction file cannot be deleted while still listed (BR-2231), so the deletion is a skill's
    const d = startNew(root, "Delete a skill");
    sh(d.worktree, "rm", "-q", ".claude/skills/x/SKILL.md");
    sh(d.worktree, "commit", "-qm", "delete");
    expect((await landReviewed(root, d.worktree)).out.kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    const b = startNew(root, "Edit the listed file");
    writeFileSync(join(b.worktree, "docs/agent.md"), "# Agent\n\nnew\n");
    sh(b.worktree, "add", "-A");
    sh(b.worktree, "commit", "-qm", "listed");
    expect((await landReviewed(root, b.worktree)).out.kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("# docs/agent.md (instruction file, loaded whole)");
    expect(kinds(root)).toEqual(["review.block"]);
  });

  test("BR-2143: an edited CLAUDE.md with no review key lands unreviewed (review.skip unconfigured); with review: none it lands with a review: none line", async () => {
    for (const review of ["", "review: none\n"]) {
      const root = project();
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${review}`);
      writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "claude");
      const s = startNew(root, "Edit CLAUDE.md");
      writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
      sh(s.worktree, "commit", "-qam", "edit");
      const r = await landReviewed(root, s.worktree);
      const skipped = ws(root).db.db.query<{ reason: string }, []>("SELECT json_extract(detail, '$.reason') AS reason FROM events WHERE kind = 'review.skip'").all().map((x) => x.reason);
      expect(r.out.kind).toBe("landed");
      if (review === "") {
        expect(r.landing).toContain("CLAUDE.md landed without a review");
        expect(r.landing).toContain("canon human ask");
        expect(r.landing).toContain("canon does not check");
        expect(skipped).toEqual(["unconfigured"]);
      } else {
        expect(r.landing).toContain("review: none — CLAUDE.md");
        expect(skipped).toEqual(["none"]);
      }
    }
  });

  describe("skill files canon shipped (BR-2410)", () => {
    const SHIPPED = ".claude/skills/canon-design/SKILL.md";
    const skill = (description: string) => `---\nname: canon-design\ndescription: ${description}\n---\nbody\n`;
    const manifestOf = (text: string) => `${JSON.stringify({ note: "Written by canon install", version: "v", files: { "canon-design/SKILL.md": createHash("sha256").update(text).digest("hex") } })}\n`;
    /** A project whose canon-design skill and manifest are as `canon update` wrote them, with a reviewer answering `verdict`. */
    function shippedProject(verdict: "ok" | "block") {
      const { root, promptFile } = standingProject(verdict);
      mkdirSync(join(root, ".claude/skills/canon-design"), { recursive: true });
      const text = skill("Use when designing.");
      writeFileSync(join(root, SHIPPED), text);
      writeFileSync(join(root, ".claude/skills/.canon-skills.json"), manifestOf(text));
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "canon install");
      return { root, promptFile };
    }
    /** Writes what `canon update` writes: a new shipped text and the manifest recording it. */
    function update(wt: string, description: string) {
      const text = skill(description);
      writeFileSync(join(wt, SHIPPED), text);
      writeFileSync(join(wt, ".claude/skills/.canon-skills.json"), manifestOf(text));
    }

    test("BR-2410: an update change that only rewrites canon's own skill as the manifest records it gets no duplicate review, even when the reviewer would block", async () => {
      const { root, promptFile } = shippedProject("block");
      const s = startNew(root, "Update canon");
      update(s.worktree, "Use when designing; repeats Use when writing tests.");
      sh(s.worktree, "commit", "-qam", "canon update");
      expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
      expect(existsSync(promptFile)).toBe(false);
    });

    test("BR-2410 BR-2143: with CLAUDE.md also changed only CLAUDE.md is the changed text; the shipped skill is marked and its full text and diff stay out; a block on the project's own line is a review.block", async () => {
      const { root, promptFile } = shippedProject("block");
      const s = startNew(root, "Update canon and CLAUDE.md");
      update(s.worktree, "Use when designing a module.");
      writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Use canon-design when designing.\n");
      sh(s.worktree, "commit", "-qam", "update and claude");
      expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
      expect(kinds(root)).toEqual(["review.block"]);
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain("# Changed in this landing: CLAUDE.md\n");
      expect(prompt).toContain(`- ${SHIPPED}: Use when designing a module. (shipped by canon)`);
      expect(prompt).toContain("- .claude/skills/x/SKILL.md: Use when writing tests\n");
      expect(prompt).toContain("cannot be changed in this project");
      expect(prompt).not.toContain(`# ${SHIPPED} (changed in this landing`);
      expect(prompt).not.toContain(`# ${SHIPPED} (diff of this landing`);
    });

    test("BR-2410: a shipped skill the project edited, so its hash no longer matches the manifest, is reviewed as the project's own text", async () => {
      const { root, promptFile } = shippedProject("ok");
      const s = startNew(root, "Edit canon-design here");
      writeFileSync(join(s.worktree, SHIPPED), skill("Use when designing, edited here."));
      sh(s.worktree, "commit", "-qam", "local edit");
      expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
      const prompt = readFileSync(promptFile, "utf8");
      expect(prompt).toContain(`# Changed in this landing: ${SHIPPED}`);
      expect(prompt).toContain(`# ${SHIPPED} (changed in this landing, full new text)`);
      expect(prompt).toContain(`- ${SHIPPED}: Use when designing, edited here.\n`);
      expect(prompt).not.toContain("(shipped by canon)");
    });

    test("BR-2410: with a manifest that is not valid JSON, a changed canon skill is reviewed as before", async () => {
      const { root, promptFile } = shippedProject("ok");
      writeFileSync(join(root, ".claude/skills/.canon-skills.json"), "{ not json");
      sh(root, "commit", "-qam", "broken manifest");
      const s = startNew(root, "Change canon-design");
      writeFileSync(join(s.worktree, SHIPPED), skill("Use when designing again."));
      sh(s.worktree, "commit", "-qam", "change");
      expect((await landReviewed(root, s.worktree, GUIDE)).out.kind).toBe("landed");
      expect(readFileSync(promptFile, "utf8")).toContain(`# Changed in this landing: ${SHIPPED}`);
    });
  });

  test("BR-2143: a duplicate reviewer that fails to run fails the review, not the landing", async () => {
    const { root } = standingProject("ok");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    sh(root, "commit", "-qam", "failing reviewer");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const r = await landReviewed(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(r.review).toContain("duplicate review could not run");
  });
});
