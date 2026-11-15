import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { land } from "../../work/land/land.ts";
import { runLandedReviews } from "./landed-queue.ts";
import { reviewBudget } from "./budget.ts";

const CLI = join(import.meta.dir, "../../invocation/main.ts");
function cli(root: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env: { ...process.env, CANON_ACTOR: "agent:budget", CANON_LANDED_REVIEWER: "0", CANON_CLEAN_AFTER_LAND: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const APPROVE = "同意本次评审";
const DECLINE = "不运行本次评审";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function fixture(extra = "review_max_calls: 1\n", duplicate = true) {
  const root = project();
  const runs = root + "-review-runs";
  const fail = root + "-review-fail";
  const script = root + "-review.sh";
  writeFileSync(script, `cat > /dev/null\necho "$CANON_REVIEW_KIND" >> ${quote(runs)}\n[ ! -e ${quote(fail)} ] || exit 3\necho '{"findings":[]}'\n`);
  const config = (settings: string) => `floor: 'true'\ntests: []\nreview: ${JSON.stringify(`sh ${quote(script)}`)}\n${settings}`;
  writeFileSync(join(root, "canon/config.yaml"), config(extra));
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回付款人\n\n## 业务\n\n- **refunds**：退款\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Team\n\nKeep team instructions.\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "review configuration");
  const change = startNew(root, "Budgeted review");
  const rule = join(change.worktree, "canon/rules/billing/BR-1.md");
  writeFileSync(rule, "---\nid: BR-1\ntitle: Refunds\nuntested: fixture\nbusiness: refunds\n---\n## 规则\n\nRefunds reach the payer in 30 days. 中文退款。\n\n## 例子\n\n- 30 days → paid\n");
  if (duplicate) writeFileSync(join(change.worktree, "CLAUDE.md"), "# Team\n\nKeep team instructions.\nRun refund checks.\n");
  const db = ws(root).db.db;
  const questions = () => db.query<{ id: number; question: string; answer: string | null }, []>("SELECT id, question, answer FROM questions ORDER BY id").all();
  const seen = () => existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : [];
  const answer = (id: number, value: string) => expect(cli(root, "human", "answer", String(id), value, "--relayed", value).code).toBe(0);
  const configure = (settings: string) => {
    writeFileSync(join(root, "canon/config.yaml"), config(settings));
    sh(root, "add", "canon/config.yaml");
    sh(root, "commit", "-qm", "budget policy");
  };
  return { root, ...change, rule, seen, fail, questions, answer, configure, db };
}

test("BR-2490: configuration exposes finite review totals and rejects invalid budgets", () => {
  const root = project();
  const defaults = cli(root, "config");
  expect(defaults.code).toBe(0);
  expect(defaults.out).toContain("review_max_calls");
  expect(defaults.out).toContain("review_max_total_prompt_kb");
  for (const [key, values] of [
    ["review_max_calls", ["0", "-1", "1.5", "'16'", ".inf"]],
    ["review_max_total_prompt_kb", ["0", "-1", "'4096'", ".nan", ".inf", "1.0e308"]],
  ] as const) {
    for (const value of values) {
      writeFileSync(join(root, "canon/config.yaml"), `floor: 'true'\nreview: none\n${key}: ${value}\n`);
      const invalid = cli(root, "config");
      expect(invalid.code).toBe(2);
      expect(invalid.err).toContain(key);
    }
  }
});

test("BR-2490 BR-2358: combined rule and duplicate overflow starts neither reviewer; pending and rejected plans stay denied", () => {
  const t = fixture();
  const first = cli(t.worktree, "work", "review");
  expect(first.code).toBe(1);
  expect(first.out + first.err).toContain("review_max_calls");
  expect(t.seen()).toEqual([]);
  expect(t.questions()).toHaveLength(1);
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.questions()).toHaveLength(1);
  t.answer(t.questions()[0]!.id, DECLINE);
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.questions()).toHaveLength(1);
  expect(t.seen()).toEqual([]);
  expect(t.db.query("SELECT 1 FROM events WHERE kind='review.preview'").get()).toBeNull();
});

test("BR-2490: explicit approval permits one exact plan; an approved failed attempt is not refunded", () => {
  const t = fixture();
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  t.answer(t.questions()[0]!.id, APPROVE);
  writeFileSync(t.fail, "fail");
  expect(cli(t.worktree, "work", "review").code).toBe(4);
  expect(t.seen()).toEqual(["preview"]);
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.questions()).toHaveLength(2);
  expect(t.seen()).toEqual(["preview"]);
});

test("BR-2490 BR-2021: a literal short assent is stored verbatim and grants one attempt; a negative assent grants none", () => {
  for (const answer of ["同意", "不同意"]) {
    const t = fixture();
    expect(cli(t.worktree, "work", "review").code).toBe(1);
    t.answer(t.questions()[0]!.id, answer);
    expect(t.questions()[0]!.answer).toBe(answer);
    writeFileSync(t.fail, "fail");
    expect(cli(t.worktree, "work", "review").code).toBe(answer === "同意" ? 4 : 1);
    expect(t.seen()).toEqual(answer === "同意" ? ["preview"] : []);
    expect(cli(t.worktree, "work", "review").code).toBe(1);
  }
});

test("BR-2490: UTF-8 totals and call counts allow equality and stop at one byte or call over", () => {
  const w = ws(project());
  const plan = { kind: "preview" as const, subject: "C-1", reviewer: "commit", command: "review", maxCalls: 2, maxBytes: 7, prompts: ["中", "文a"] };
  const allowed = reviewBudget(w.db, w.actor, plan);
  expect(allowed.ok && allowed.value.allowed).toBe(true);
  for (const over of [{ ...plan, maxBytes: 6 }, { ...plan, maxCalls: 1 }]) {
    const denied = reviewBudget(w.db, w.actor, over);
    expect(denied.ok && denied.value.allowed).toBe(false);
  }
  expect(w.db.db.query("SELECT id FROM questions").all()).toHaveLength(2);
});

test("BR-2490 BR-2443: total bytes alone can stop a preview before either reviewer or the related picker runs", () => {
  const t = fixture("review_max_calls: 16\nreview_max_total_prompt_kb: 0.01\n", false);
  const picker = t.root + "-picker";
  t.configure(`review_max_calls: 16\nreview_max_total_prompt_kb: 0.01\nrelated_pick_command: ${JSON.stringify(`echo called >> ${quote(picker)}; echo '{}'`)}\n`);
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.seen()).toEqual([]);
  expect(existsSync(picker)).toBe(false);
  expect(t.questions()[0]!.question).toContain("review_max_total_prompt_kb=0.01");
});

test("BR-2490 BR-2361: an approved combined preview runs once; a cached rule costs zero calls on the next preview", () => {
  const t = fixture();
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  t.answer(t.questions()[0]!.id, APPROVE);
  expect(cli(t.worktree, "work", "review").code).toBe(0);
  expect(t.seen()).toEqual(["preview", "preview"]);
  // The duplicate call alone equals the limit; the full rule prompt is reused and must not be counted.
  expect(cli(t.worktree, "work", "review").code).toBe(0);
  expect(t.seen()).toEqual(["preview", "preview", "preview"]);
  expect(t.questions()).toHaveLength(1);
});

test("BR-2490 BR-2074: worktree budgets cannot grant approval; changed input and trusted reviewer commits invalidate it", () => {
  const t = fixture();
  writeFileSync(join(t.worktree, "canon/config.yaml"), readFileSync(join(t.worktree, "canon/config.yaml"), "utf8").replace("review_max_calls: 1", "review_max_calls: 999"));
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  t.answer(t.questions()[0]!.id, APPROVE);
  writeFileSync(t.rule, readFileSync(t.rule, "utf8").replace("30 days", "31 days"));
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.questions()).toHaveLength(2);
  t.answer(t.questions()[1]!.id, APPROVE);
  t.configure("review_max_calls: 1\n# new trusted reviewer commit\n");
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  expect(t.questions()).toHaveLength(3);
  expect(t.seen()).toEqual([]);
});

test("BR-2490: concurrent CLI retries spend one approval at most", async () => {
  const t = fixture();
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  t.answer(t.questions()[0]!.id, APPROVE);
  writeFileSync(t.fail, "fail");
  const run = async () => {
    const p = Bun.spawn([process.execPath, CLI, "work", "review"], { cwd: t.worktree, env: { ...process.env, CANON_ACTOR: "agent:budget" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return code;
  };
  expect((await Promise.all([run(), run()])).sort()).toEqual([1, 4]);
  expect(t.seen()).toEqual(["preview"]);
  expect(t.questions()).toHaveLength(2);
});

test("BR-2490: a question or consumption write failure starts no reviewer", () => {
  const t = fixture();
  t.db.exec("CREATE TRIGGER fail_budget_ask BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT, 'question unavailable'); END");
  expect(cli(t.worktree, "work", "review").code).toBe(4);
  expect(t.seen()).toEqual([]);
  t.db.exec("DROP TRIGGER fail_budget_ask");
  expect(cli(t.worktree, "work", "review").code).toBe(1);
  t.answer(t.questions()[0]!.id, APPROVE);
  t.db.exec("CREATE TRIGGER fail_budget_consume BEFORE INSERT ON events WHEN NEW.kind='review.budget.consume' BEGIN SELECT RAISE(ABORT, 'approval unavailable'); END");
  expect(cli(t.worktree, "work", "review").code).toBe(4);
  expect(t.seen()).toEqual([]);
});

test("BR-2490 BR-2441 BR-2449: post-land budget denial preserves the landing, reports the question, and an approved --again survives a new job id", async () => {
  const t = fixture();
  sh(t.worktree, "add", "-A");
  sh(t.worktree, "commit", "-qm", "reviewed changes");
  const landingLines: string[] = [];
  const landing = await land(ws(t.worktree), FAST, l => landingLines.push(l));
  expect({ landing, lines: landingLines }).toMatchObject({ landing: { kind: "landed" } });
  const landed = sh(t.root, "rev-parse", "main");
  expect((await runLandedReviews(ws(t.root), quiet, undefined)).ok).toBe(true);
  const jobs = () => t.db.query<{ id: number; state: string }, []>("SELECT id, state FROM landed_reviews ORDER BY id").all();
  expect(jobs()[0]!.state).toBe("failed");
  expect(t.seen()).toEqual([]);
  const report = cli(t.root, "work", "after-land", "--wait", t.change);
  expect(report.out + report.err).toContain(`question #${t.questions()[0]!.id}`);
  expect(t.db.query("SELECT id FROM events WHERE kind='review.fail'").all()).toHaveLength(1);
  // --again uses current main as reviewer: establish that exact plan before approving it.
  expect(cli(t.root, "work", "review-landed", "--again", t.change).code).toBe(0);
  expect((await runLandedReviews(ws(t.root), quiet, undefined)).ok).toBe(true);
  expect(t.questions()).toHaveLength(2);
  t.answer(t.questions()[1]!.id, APPROVE);
  expect(cli(t.root, "work", "review-landed", "--again", t.change).code).toBe(0);
  expect((await runLandedReviews(ws(t.root), quiet, undefined)).ok).toBe(true);
  expect(jobs().map((j) => j.state)).toEqual(["failed", "failed", "done"]);
  expect(t.seen()).toEqual(["land", "land"]);
  expect(sh(t.root, "rev-parse", "main")).toBe(landed);
});
