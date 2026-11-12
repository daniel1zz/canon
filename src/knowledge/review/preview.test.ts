import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { previewReview } from "./preview.ts";
import { project, sh, startNew, ws } from "../../work/testkit.ts";

const CLI = join(import.meta.dir, "../../invocation/main.ts");
const id = ["BR", 1].join("-");

/** A project whose main has a billing domain, an instruction file CLAUDE.md and the given review settings. */
function billing(review: string | undefined) {
  const root = project();
  const log = join(root, "..", `${root.split("/").pop()}-reviews.log`);
  const script = join(root, "..", `${root.split("/").pop()}-reviewer.sh`);
  const answer = (verdict: string) => `{"verdict":"${verdict}","findings":["${id} is ${verdict}"]}`;
  const reviewer = (body: string) => {
    writeFileSync(script, `#!/bin/sh\npwd -P >> ${log}.cwd\ncat > ${log}.last\ncp ${log}.last ${script}.prompt\necho run >> ${log}\n${body}\n`);
    chmodSync(script, 0o755);
  };
  reviewer(`echo '${answer("ok")}'`);
  const reviewLine = review === undefined ? "" : review === "none" ? "review: none\n" : `review: ${JSON.stringify(script)}\n`;
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\ninstructions: [CLAUDE.md]\n${reviewLine}`);
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nRun the tests.\n");
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
  const events = () => ws(root).db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind LIKE 'review.%' ORDER BY id").all();
  return { root, reviewer, answer, runs, events, lastPrompt: () => readFileSync(`${log}.last`, "utf8"), cwds: () => readFileSync(`${log}.cwd`, "utf8").trim().split("\n") };
}
const ruleText = (text: string) => `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;
const reviewTrees = (root: string) => sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.includes("/review/"));
const guide = "guide text";

describe("canon work review", () => {
  test("BR-2358: ok with a note: the note is printed, the reviewer read the uncommitted and untracked text, and only review.preview is recorded", async () => {
    const t = billing("on");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are paid in 30 days.")); // untracked
    const out = await previewReview(ws(s.worktree), guide);
    expect(out).toMatchObject({ kind: "ok", behind: 0, findings: [{ review: "rule", text: `${id} is ok` }] });
    expect(t.lastPrompt()).toContain("Refunds are paid in 30 days.");
    expect(t.lastPrompt()).toContain(`- ${id} [billing] Refunds`);
    expect(t.events().map((e) => e.kind)).toEqual(["review.preview"]);
    expect(JSON.parse(t.events()[0]!.detail)).toMatchObject({ verdict: "ok", findings: 1, docs: [id] }); // the reviews the landing queues (BR-2441), recorded only as a preview
    // a second edit of the same file, still uncommitted, is what is read next
    sh(s.worktree, "add", "-A");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are paid in 45 days."));
    await previewReview(ws(s.worktree), guide);
    expect(t.lastPrompt()).toContain("Refunds are paid in 45 days.");
  });

  test("BR-2387 BR-2358: the preview lists the rules most related to the changed rule, after the verdict, without changing it", async () => {
    const t = billing("on");
    const other = ["BR", 7].join("-");
    mkdirSync(join(t.root, "canon/rules/shipping"), { recursive: true });
    writeFileSync(join(t.root, "canon/rules/shipping/README.md"), "---\ncode: [src/shipping]\n---\n# shipping\n\n## 术语\n\n- **发货**：寄出\n");
    writeFileSync(join(t.root, `canon/rules/shipping/${other}.md`), `---\nid: ${other}\ntitle: Ship after refund check\nuntested: demo\n---\n## 规则\n\n看 \`refund.issued\`。\n\n## 例子\n\n- a → b\n`);
    sh(t.root, "add", "-A");
    sh(t.root, "commit", "-qm", "shipping");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("退款时写 `refund.issued`。"));
    const out = await previewReview(ws(s.worktree), guide);
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.related).toEqual([`Related to ${id} (references both ways, shared text and names; check they do not contradict it):`, `  ${other} Ship after refund check  (\`refund.issued\`; words refund issued)`, "      看 `refund.issued`。"]);
    const none = billing("on");
    const s2 = startNew(none.root, "Alone");
    writeFileSync(join(s2.worktree, `canon/rules/billing/${id}.md`), ruleText("退款时写 `refund.issued`。"));
    const quiet = await previewReview(ws(s2.worktree), guide);
    expect(quiet.kind === "ok" && quiet.related).toEqual([]);
  });

  test("BR-2358: a block verdict is block with its findings", async () => {
    const t = billing("on");
    t.reviewer(`echo '${t.answer("block")}'`);
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "block", findings: [{ review: "rule", text: `${id} is block` }] });
    expect(JSON.parse(t.events()[0]!.detail)).toMatchObject({ verdict: "block" });
  });

  test("BR-2358: a change to a rule and to CLAUDE.md runs the rule review and the duplicate review; either one blocking blocks", async () => {
    const t = billing("on");
    const s = startNew(t.root, "Both");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are paid in 30 days."));
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nRun the tests.\nRun the tests always.\n");
    const ok = await previewReview(ws(s.worktree), guide);
    expect(ok.kind).toBe("ok");
    expect(t.runs()).toBe(2);
    expect(t.lastPrompt()).toContain("Run the tests always.");
    t.reviewer(`if grep -q 'You review the standing instructions' "$0.prompt"; then echo '${t.answer("block")}'; else echo '${t.answer("ok")}'; fi`);
    const out = await previewReview(ws(s.worktree), guide);
    expect(out).toMatchObject({ kind: "block", findings: [{ review: "rule" }, { review: "duplicate" }] });
    expect(out.kind === "block" && out.findings.map((f) => f.text)).toEqual([`${id} is ok`, `${id} is block`]);
  });

  test("BR-2358: a reviewer that exits 3 or prints no JSON is a failure that names the review", async () => {
    for (const body of ["exit 3", "echo nothing"]) {
      const t = billing("on");
      t.reviewer(body);
      const s = startNew(t.root, "New rule");
      writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
      const out = await previewReview(ws(s.worktree), guide);
      expect(out.kind).toBe("failed");
      expect(out.kind === "failed" && out.message).toContain("the rule review could not run");
      expect(t.events()).toEqual([]);
      expect(reviewTrees(t.root)).toEqual([]);
    }
  });

  test("BR-2358: a change of code only has nothing to review and the reviewer is not run; with no review configured that is the same", async () => {
    for (const review of ["on", undefined]) {
      const t = billing(review);
      const s = startNew(t.root, "Code");
      writeFileSync(join(s.worktree, "src/billing/a.ts"), "export const a = 1;\n");
      expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "nothing" });
      expect(t.runs()).toBe(0);
    }
  });

  test("BR-2358: review none is said and the reviewer is not run", async () => {
    const t = billing("none");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "off" });
    expect(t.runs()).toBe(0);
  });

  test("BR-2358: no review on main and a changed rule is unconfigured, even when the change sets one itself", async () => {
    const t = billing(undefined);
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "true"\n`);
    expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "unconfigured", needs: [id] });
    expect(t.runs()).toBe(0);
  });

  test("BR-2358: the reviewer is main's: a change that swaps it still runs main's, in a temporary worktree at main's commit that is gone afterwards", async () => {
    const t = billing("on");
    const s = startNew(t.root, "Swap");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"verdict\\":\\"block\\",\\"findings\\":[]}'"\n`);
    expect((await previewReview(ws(s.worktree), guide)).kind).toBe("ok");
    expect(t.cwds()[0]).toContain("/review/");
    expect(existsSync(t.cwds()[0]!)).toBe(false);
    expect(reviewTrees(t.root)).toEqual([]);
  });

  test("BR-2358: the worktree's files and index are as they were, and no review.ok, review.block or note is recorded", async () => {
    const t = billing("on");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nchanged\n");
    sh(s.worktree, "add", "CLAUDE.md");
    const status = sh(s.worktree, "status", "--porcelain");
    const tracked = sh(s.worktree, "ls-files", "--stage");
    await previewReview(ws(s.worktree), guide);
    expect(sh(s.worktree, "status", "--porcelain")).toBe(status);
    expect(sh(s.worktree, "ls-files", "--stage")).toBe(tracked);
    expect(t.events().map((e) => e.kind)).toEqual(["review.preview"]);
  });

  test("BR-2358: in the primary checkout, or in a worktree no change claims, it is a usage error and nothing runs", async () => {
    const t = billing("on");
    expect(await previewReview(ws(t.root), guide)).toMatchObject({ kind: "usage" });
    const loose = join(t.root, "..", `${t.root.split("/").pop()}-loose`);
    sh(t.root, "worktree", "add", "-q", "-b", "loose", loose, "main");
    const out = await previewReview(ws(loose), guide);
    expect(out).toMatchObject({ kind: "usage" });
    expect(t.runs()).toBe(0);
  });

  test("BR-2358: a branch behind main is reviewed as it is and reports how far; one at main's tip reports none", async () => {
    const t = billing("on");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "ok", behind: 0 });
    for (const n of [1, 2]) {
      writeFileSync(join(t.root, `m${n}.txt`), "m\n");
      sh(t.root, "add", "-A");
      sh(t.root, "commit", "-qm", `m${n}`);
    }
    expect(await previewReview(ws(s.worktree), guide)).toMatchObject({ kind: "ok", behind: 2 });
  });

  test("BR-2358: the command exits 1 on block and 0 on ok, 4 on a failing reviewer, 2 outside a change, and prints the behind line", () => {
    const t = billing("on");
    const s = startNew(t.root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    writeFileSync(join(t.root, "m.txt"), "m\n");
    sh(t.root, "add", "-A");
    sh(t.root, "commit", "-qm", "m");
    const run = (cwd: string) => {
      const r = Bun.spawnSync(["bun", CLI, "work", "review"], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const ok = run(s.worktree);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("review: ok");
    expect(ok.out).toContain("1 commit(s) after this branch's merge base");
    // reason: the same prompt that passed is not asked again (BR-2361), so each run below changes the rule text
    const reword = (text: string) => writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText(text));
    t.reviewer(`echo '${t.answer("block")}'`);
    reword("Refunds are fine, second.");
    const block = run(s.worktree);
    expect(block.code).toBe(1);
    expect(block.out).toContain(`review finding (rule): ${id} is block`);
    t.reviewer("exit 3");
    reword("Refunds are fine, third.");
    expect(run(s.worktree).code).toBe(4);
    expect(run(t.root).code).toBe(2);
  }, 60_000);
});
