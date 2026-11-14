import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../../work/db.ts";
import { readConfig } from "../../invocation/config.ts";
import { readCorpus } from "../documents/read.ts";
import { testFilesFor } from "./tests.ts";
import { check, staleReportNotes } from "./check.ts";
import type { TestReports } from "../../work/verify/ledger.ts";
import type { TestCase } from "../../work/verify/report.ts";
import { verify } from "./sources.ts";

// Fixture ids are assembled at runtime, so this file's own text names no rule.
const br = (n: number) => ["BR", n].join("-");
const d = (n: number) => ["D", n].join("-");

const tc = (name: string, more: Partial<TestCase> = {}): TestCase => ({ suites: [], classname: "", name, runs: true, ...more });
/** Check input for a project whose test files are exactly the ones in `reports`. */
const withReports = (root: string, reports: TestReports) => ({ root, ...readCorpus(root), testFiles: [...reports.files.keys()], reports });

/** What the ledger holds: each file's testcases, fresh unless the file is listed in `stale`; `relevant` files are the ones this change touches (BR-2344). */
const reportsOf = (files: Record<string, TestCase[]>, o: { stale?: string[]; relevant?: string[] } = {}): TestReports => ({
  files: new Map(Object.entries(files).map(([f, cases]) => [f, { cases, fresh: !(o.stale ?? []).includes(f) }])),
  relevant: new Set(o.relevant ?? []),
});

/** Fixture repo; the code directories the fixture domains name exist, as BR-2079 requires. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-check-"));
  for (const dir of ["src/billing", "src/auth"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const domainReadme = "---\ncode: [src/billing]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n";
const ruleFile = (n: number, extra = "") => `---\nid: ${br(n)}\ntitle: Rule ${n}\n${extra}---\n## 规则\n\nStatement ${n}.\n\n## 例子\n\n- day 30 → refunded\n`;

describe("canon check", () => {
  test("BR-2004 BR-2005: a clean corpus whose rules are all tested has no findings", () => {
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/decisions/${d(1)}-x.md`]: `---\nid: ${d(1)}\ntitle: X\nstatus: accepted\n---\n## 背景\n\nBecause ${br(1)}. Example only: \`${br(77)}\`.\n\n\`\`\`\n${br(78)}\n\`\`\`\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nB.\n`,
      "src/billing/refund.test.ts": `it("${br(1)}: refuses day 31", () => {});`,
    });
    const r = readCorpus(root);
    expect(check({ ...withReports(root, reportsOf({ "src/billing/refund.test.ts": [tc(`${br(1)}: refuses day 31`)] })), ...r })).toEqual([]);
  });

  test("BR-2001 BR-2004 BR-2005 BR-2042: reports each outcome violation by its rule name", () => {
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/rules/billing/${br(2)}.md`]: ruleFile(2, "status: retired\n"),
      [`canon/rules/billing/${br(3)}.md`]: ruleFile(3, "untested: covered by the payment provider's contract\n"),
      [`canon/rules/billing/${br(4)}.md`]: `---\nid: ${br(5)}\ntitle: Wrong id\n---\nx\n`,
      [`canon/changes/C-1-a.md`]: `---\nid: C-1\ntitle: A\nrules: [${br(9)}]\n---\n## 为什么\n\nTouches ${br(1)}.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n`,
      "src/billing/a.test.ts": `it("${br(2)} old", () => {}); it("${br(7)}", () => {});`,
    });
    const findings = check(withReports(root, reportsOf({ "src/billing/a.test.ts": [tc(`${br(2)} old`), tc(br(7))] })));
    const summary = findings.map((f) => `${f.rule} ${f.path}`).sort();
    expect(summary).toEqual(
      [
        `file-invalid canon/rules/billing/${br(4)}.md`, // id does not match the file name
        "ref-dangling canon/changes/C-1-a.md", // change lists a rule that does not exist
        "ref-dangling src/billing/a.test.ts", // test names a rule that does not exist
        `rule-untested canon/rules/billing/${br(1)}.md`, // active, no test, no reason
        "test-retired-rule src/billing/a.test.ts",
      ].sort(),
    );
  });

  test("BR-2005: only a testcase that runs and whose names carry the id makes a rule tested; skipped ones, the file's text and a missing report do not", () => {
    const id = br(1);
    const untested = (cases: TestCase[] | undefined, o: { stale?: string[] } = {}) => {
      const file = "src/billing/a.test.ts";
      const root = repo({ "canon/rules/billing/README.md": domainReadme, [`canon/rules/billing/${id}.md`]: ruleFile(1), [file]: `// ${id} only in the file's text\n` });
      return check({ root, ...readCorpus(root), testFiles: [file], reports: reportsOf(cases ? { [file]: cases } : {}, o) }).filter((f) => f.rule === "rule-untested");
    };
    for (const tested of [
      [tc(`${id}: refunds day 30`)],
      [tc(`${id}: fails`)], // a failing test ran
      [tc("first", { suites: ["a.test.ts", id], classname: id })], // the id is in a describe
      [tc("x", { classname: id })],
      [tc("x", { suites: [id] })],
      [tc(`${id} case one`), tc(`${id} case two`, { runs: false })],
      [tc("x", { runs: false }), tc(`test_param[${id}-one]`)], // pytest puts a parameter id in the name
    ]) expect([JSON.stringify(tested), untested(tested).length]).toEqual([JSON.stringify(tested), 0]);
    for (const loose of [
      [tc(`${id}: later`, { runs: false })], // skipped or todo
      [tc("x", { suites: ["a.test.ts"], classname: "BR_1" })], // a different spelling is another name
      [tc("plain")], // the id is only in the file's text, which canon does not read
      [], // an empty report
    ]) expect([JSON.stringify(loose), untested(loose).length]).toEqual([JSON.stringify(loose), 1]);
    expect(untested(undefined)[0]!.message).toContain("1 test file(s) have no report: run canon work test --all");
    expect(untested([])[0]!.message).toContain("reports with no testcase: src/billing/a.test.ts");
  });

  test("BR-2005: a file without a report for its current content counts by its newest older report unless this change touches it", () => {
    const file = "src/billing/a.test.ts";
    const root = repo({ "canon/rules/billing/README.md": domainReadme, [`canon/rules/billing/${br(1)}.md`]: ruleFile(1), [file]: "x\n" });
    const run = (o: { relevant?: string[] }) => check({ root, ...readCorpus(root), testFiles: [file], reports: reportsOf({ [file]: [tc(`${br(1)}: a`)] }, { stale: [file], ...o }) }).map((f) => f.rule);
    expect(run({})).toEqual([]);
    expect(run({ relevant: [file] })).toEqual(["test-report-missing", "rule-untested"]);
  });

  test("BR-2004 BR-2042: ids in test names are checked even when the test is skipped; ids that are in no testcase name are not", () => {
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      [`canon/rules/billing/${br(2)}.md`]: ruleFile(2, "status: retired\n"),
      "src/billing/a.test.ts": `// ${br(8)} and ${br(2)} in a comment\ntest("${br(1)}", () => { const s = "${br(9)}"; });`,
      "src/billing/b.test.ts": "x\n",
    });
    const reports = reportsOf({ "src/billing/a.test.ts": [tc(br(1))], "src/billing/b.test.ts": [tc(`${br(7)} later`, { runs: false }), tc(`${br(2)} old`, { runs: false })] });
    const got = check(withReports(root, reports)).map((f) => `${f.rule} ${f.path} ${f.message}`);
    expect(got).toEqual([`ref-dangling src/billing/b.test.ts test names ${br(7)}, which does not exist`, `test-retired-rule src/billing/b.test.ts test still names retired rule ${br(2)}`]);
  });

  test("BR-2344: a test file this change touches without a report for its content is one finding naming the files and the command; others are not", () => {
    const files = ["src/billing/a.test.ts", "src/billing/b.test.ts", "src/billing/c.test.ts"];
    const root = repo({ "canon/rules/billing/README.md": domainReadme, [`canon/rules/billing/${br(1)}.md`]: ruleFile(1), ...Object.fromEntries(files.map((f) => [f, "x\n"])) });
    const findings = (reports: TestReports) => check({ root, ...readCorpus(root), testFiles: files, reports }).filter((f) => f.rule === "test-report-missing");
    const ok = reportsOf({ [files[0]!]: [tc(br(1))] });
    expect(findings(ok)).toEqual([]); // b and c have no report at all, but this change does not touch them
    const two = findings({ files: ok.files, relevant: new Set([files[1]!, files[2]!]) });
    expect(two.length).toBe(1);
    expect(two[0]!.message).toBe("2 test file(s) this change touches have no report for their current content (src/billing/b.test.ts, src/billing/c.test.ts): run canon work test src/billing/b.test.ts src/billing/c.test.ts");
    const many = Array.from({ length: 7 }, (_, i) => `src/billing/m${i}.test.ts`);
    const seven = check({ root, ...readCorpus(root), testFiles: many, reports: { files: new Map(), relevant: new Set(many) } }).filter((f) => f.rule === "test-report-missing");
    expect(seven[0]!.message).toContain("7 test file(s)");
    expect(seven[0]!.message).toContain("src/billing/m4.test.ts, and 2 more");
  });

  test("BR-2345: files changed since their last report are said once as a note and do not fail the check", () => {
    const files = ["src/billing/a.test.ts", "src/billing/b.test.ts"];
    const root = repo({ "canon/rules/billing/README.md": domainReadme, [`canon/rules/billing/${br(1)}.md`]: ruleFile(1), ...Object.fromEntries(files.map((f) => [f, "x\n"])) });
    const reports = reportsOf({ [files[0]!]: [tc(br(1))], [files[1]!]: [tc("x")] }, { stale: files });
    const input = { root, ...readCorpus(root), testFiles: files, reports };
    expect(check(input)).toEqual([]);
    const notes = staleReportNotes(input);
    expect(notes.length).toBe(1);
    expect(notes[0]!.rule).toBe("test-report-stale");
    expect(notes[0]!.message).toContain("2 test file(s) changed since their last report (src/billing/a.test.ts, src/billing/b.test.ts)");
    expect(staleReportNotes({ ...input, reports: reportsOf({ [files[0]!]: [tc(br(1))] }) })).toEqual([]);
    expect(staleReportNotes({ ...input, reports: { ...reports, relevant: new Set(files) } })).toEqual([]); // a relevant file is a finding, not a note
  });

  test("BR-2006: a domain without README is invalid, so its code scope is never silently empty", () => {
    const root = repo({ [`canon/rules/auth/${br(1)}.md`]: ruleFile(1, "untested: n/a\n") });
    const findings = check({ root, ...readCorpus(root), testFiles: [] });
    expect(findings.map((f) => f.rule)).toEqual(["file-invalid"]);
  });

  test("BR-2006: without code_root a top-level README without `code`, or with an empty list, is invalid; one code directory is enough", () => {
    const root = repo({
      "canon/rules/a/README.md": "---\ntitle: a\n---\n# a\n\n## 术语\n\n- **退款**：钱退回\n",
      "canon/rules/b/README.md": "---\ncode: []\n---\n# b\n\n## 术语\n\n- **退款**：钱退回\n",
      "canon/rules/c/README.md": "---\ncode: [src/auth]\n---\n# c\n\n## 术语\n\n- **退款**：钱退回\n",
    });
    const findings = check({ root, ...readCorpus(root), testFiles: [] });
    expect(findings.map((f) => `${f.rule} ${f.path}`).sort()).toEqual(["file-invalid canon/rules/a/README.md", "file-invalid canon/rules/b/README.md"]);
  });

  test("BR-2004: a decision id named bare in a change body, or a decision's supersedes naming nothing, is reported on that file", () => {
    const dec = (n: number, extra: string) => `---\nid: ${d(n)}\ntitle: X\nstatus: proposed\n${extra}---\n## 背景\n\nx\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nB.\n`;
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      "canon/changes/C-1-a.md": `---\nid: C-1\ntitle: A\nrules: []\n---\n## 为什么\n\nAs ${d(99)} said; example only: \`${d(98)}\`.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n`,
      [`canon/decisions/${d(1)}.md`]: dec(1, `supersedes: ${d(97)}\n`),
      [`canon/decisions/${d(2)}.md`]: dec(2, `supersedes: ${d(1)}\n`),
    });
    const got = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "ref-dangling").map((f) => `${f.path} ${f.message}`).sort();
    expect(got).toEqual([`canon/changes/C-1-a.md names ${d(99)}, which does not exist`, `canon/decisions/${d(1)}.md names ${d(97)}, which does not exist`]);
  });

  test("BR-2150: a backlog id that is no change is reported by line; a done or a dropped change is not", () => {
    const change = (n: number, status: string) => `---\nid: C-${n}\ntitle: X\nstatus: ${status}\nrules: []\n---\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [ ] x\n`;
    const root = repo({
      "canon/rules/billing/README.md": domainReadme,
      "canon/changes/C-1.md": change(1, "done"),
      "canon/changes/C-2.md": change(2, "dropped"),
      "canon/backlog.md": `- C-1\n- C-2\n- ${["C", 99].join("-")}\n`,
    });
    const got = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "ref-dangling").map((f) => `${f.path}: ${f.message}`);
    expect(got).toEqual([`canon/backlog.md:3: lists ${["C", 99].join("-")}, which is not a change`]);
  });

  test("BR-2004: a domain README naming an id that does not exist is reported on the README", () => {
    const root = repo({ "canon/rules/billing/README.md": `${domainReadme}\nSee ${br(9999)}. Example only: \`${br(9998)}\`.\n` });
    const findings = check({ root, ...readCorpus(root), testFiles: [] });
    expect(findings.map((f) => `${f.rule} ${f.path} ${f.message}`)).toEqual([`ref-dangling canon/rules/billing/README.md names ${br(9999)}, which does not exist`]);
  });
});

describe("rule shape", () => {
  const readme = { "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n" };
  const fileOf = (n: number, body: string, extra = "") => ({ [`canon/rules/billing/${br(n)}.md`]: `---\nid: ${br(n)}\ntitle: R${n}\n${extra}---\n${body}` });
  const run = (files: Record<string, string>) => {
    const ids = Object.keys(files).map((p) => p.split("/").pop()!.replace(/\.md$/, ""));
    const root = repo({ ...readme, ...files, "src/billing/a.test.ts": "x\n" });
    return check(withReports(root, reportsOf({ "src/billing/a.test.ts": [tc(ids.join(" "))] }))).map((f) => `${f.rule} ${f.path.split("/").pop()}`).sort();
  };

  test("BR-2033: an active rule without a non-empty statement section is reported", () => {
    expect(run({ ...fileOf(1, "Just text.\n\n## 例子\n\n- a → b\n"), ...fileOf(2, "## 规则\n\n\n## 例子\n\n- a → b\n") })).toEqual([
      `rule-no-statement ${br(1)}.md`,
      `rule-no-statement ${br(2)}.md`,
    ]);
  });

  test("BR-2034: a tested active rule needs a real example; an untested or retired one does not", () => {
    expect(
      run({
        ...fileOf(1, "## 规则\n\nS.\n"),
        ...fileOf(2, "## 规则\n\nS.\n\n## 例子\n\n"),
        ...fileOf(3, "## 规则\n\nS.\n", "untested: provider contract\n"),
        ...fileOf(4, "## 规则\n\nS.\n", "status: retired\n"),
      }),
    ).toEqual([`rule-no-example ${br(1)}.md`, `rule-no-example ${br(2)}.md`, "test-retired-rule a.test.ts"]);
  });

  test("BR-2301: an example that states the behaviour before the change is reported; the wording in code, in the statement or in a retired rule is not", () => {
    const rule = (example: string) => `## 规则\n\nS，在做任何改动之前检查。\n\n## 例子\n\n${example}\n`;
    expect(
      run({
        ...fileOf(1, rule("- 退款第 31 天 → 拒绝；改动前照样退款")),
        ...fileOf(2, rule("- day 31 → refused; previously it refunded")),
        ...fileOf(3, rule("- 输出里有 `改动前`")), // product output written as code
        ...fileOf(4, rule("- `info/exclude` 原来是 `.env` → 变成两行，原来的行原样保留")), // the input's earlier state, not the product's
        ...fileOf(5, rule("- 第 31 天 → 拒绝")), // the statement says 改动之前, which is ordering, not history
        ...fileOf(6, rule("- day 31 → refunded; before this change it was refused"), "status: retired\n"),
      }),
    ).toEqual([`example-before-change ${br(1)}.md`, `example-before-change ${br(2)}.md`, "test-retired-rule a.test.ts"]);
  });

  test("BR-2035: a placeholder line left from a template is reported, but not one written as code", () => {
    const root = repo({
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n<这个领域管什么、不管什么。>\n",
      ...fileOf(1, "## 规则\n\nS.\n\n## 例子\n\n- <边界上的具体输入或状态> → <必须出现的结果>\n- `canon work start <C-n>` → starts\n"),
      [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: X\n---\n## 背景\n\n<为什么需要做这个决定，有哪些事实和数据。>\n\n\`\`\`\n<kept as code>\n\`\`\`\n`,
      "canon/changes/C-1.md": "---\nid: C-1\ntitle: X\n---\n## 为什么\n\n<要解决什么问题。>\n",
      "src/billing/a.test.ts": "x\n",
    });
    const got = check(withReports(root, reportsOf({ "src/billing/a.test.ts": [tc(br(1))] }))).filter((f) => f.rule === "template-unfilled").map((f) => f.path.split("/").pop()).sort();
    expect(got).toEqual([`${br(1)}.md`, `${d(1)}.md`, "C-1.md", "README.md"].sort());
  });

  test("BR-2035: a 来源 line of the decision template is a placeholder until it names a real source", () => {
    const unfilled = `---\nid: ${d(1)}\ntitle: X\n---\n## 方案\n\n1. A：采用。\n   - 来源：<网址或仓库里的文件路径> “<原文摘录，至少 8 个字符>”\n`;
    const filled = unfilled.replace("<网址或仓库里的文件路径> “<原文摘录，至少 8 个字符>”", "src/x.ts “export function check(”");
    const unfilledRoot = repo({ [`canon/decisions/${d(1)}.md`]: unfilled });
    const filledRoot = repo({ [`canon/decisions/${d(1)}.md`]: filled });
    expect(check({ root: unfilledRoot, ...readCorpus(unfilledRoot), testFiles: [] }).some((f) => f.rule === "template-unfilled")).toBe(true);
    expect(check({ root: filledRoot, ...readCorpus(filledRoot), testFiles: [] }).some((f) => f.rule === "template-unfilled")).toBe(false);
  });

  test("BR-2035: every placeholder form the built-in templates leave is reported; prose with angle brackets and code blocks are not", () => {
    const filled = "## 为什么\n\nBecause.\n";
    const root = repo({
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **<术语>**：<在这个领域里的含义>\n",
      "canon/changes/C-1.md": `---\nid: C-1\ntitle: Task left\n---\n${filled}\n## 任务\n\n- [ ] <任务>\n`,
      [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: Option left\n---\n## 方案\n\n1. <方案一>：<采用或否决，以及理由>\n`,
      "canon/changes/C-2.md": `---\nid: C-2\ntitle: Prose\n---\n${filled}\n金额 <100 元时免运费\n\n- [x] 写好了 <C-2> 的测试\n`,
      "canon/changes/C-3.md": `---\nid: C-3\ntitle: Code block\n---\n${filled}\n\`\`\`\n<占位>\n- [ ] <任务>\n\`\`\`\n`,
    });
    const got = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "template-unfilled").map((f) => f.path.split("/").pop()).sort();
    expect(got).toEqual([`${d(1)}.md`, "C-1.md", "README.md"].sort());
  });
});

describe("required sections", () => {
  test("BR-2091: a missing or placeholder-only required section is reported whatever the status; extra sections are not", () => {
    const terms = "## 术语\n\n- **退款**：钱退回\n";
    const change = (n: number, body: string) => ({ [`canon/changes/C-${n}.md`]: `---\nid: C-${n}\ntitle: C${n}\nstatus: done\n---\n${body}` });
    const root = repo({
      "canon/rules/billing/README.md": `---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n${terms}`,
      "canon/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n\nLogin.\n\n## 术语\n\n",
      "canon/rules/pay/README.md": "---\ncode: [src/pay]\n---\n# pay\n\nPayments.\n",
      ...change(1, "## 为什么\n\nW.\n"),
      ...change(2, "## 为什么\n\nW.\n\n## 要改什么\n\n<具体改动，以及会新增或修改哪些规则。>\n"),
      ...change(4, "## 为什么\n\nW.\n\n## 要改什么\n\nX.\n"),
      ...change(3, "## 为什么\n\nW.\n\n## 要改什么\n\nX.\n\n## 陷阱和假设\n\nY.\n\n## 任务\n\n- [x] X\n"),
      [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: X\nstatus: superseded\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n`,
      "canon/notes/N-1.md": "---\nid: N-1\ntitle: Free\n---\nAnything.\n",
    });
    const got = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "doc-missing-section").map((f) => `${f.path.split("/").pop()} ${f.message}`);
    expect(got.sort()).toEqual(
      [
        "C-1.md C-1 lacks or leaves empty: ## 要改什么",
        "C-2.md C-2 lacks or leaves empty: ## 要改什么",
        `${d(1)}.md ${d(1)} lacks or leaves empty: ## 后果`,
        "README.md domain auth README lacks or leaves empty: ## 术语",
        "README.md domain pay README lacks or leaves empty: ## 术语",
      ].sort(),
    );
  });
});

describe("decision options and sources", () => {
  const decision = (n: number, options: string) =>
    ({ [`canon/decisions/${d(n)}.md`]: `---\nid: ${d(n)}\ntitle: X\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n${options}\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n` });
  const run = (files: Record<string, string>, rule: string) =>
    check({ root: repo(files), ...readCorpus(repo(files)), testFiles: [] }).filter((f) => f.rule === rule).map((f) => f.message).sort();

  test("BR-2109: options must be a real choice: two or more, each taken or rejected, at least one of each", () => {
    const got = run(
      {
        ...decision(1, "1. A：采用。"),
        ...decision(2, "1. A：采用。\n2. B：采用。"),
        ...decision(3, "1. A：采用。\n2. B：否决。\n3. C。负责人这次没有选，不做。"),
        ...decision(4, "1. A：采用。\n2. B，先试过，\n   后否决：太慢。"),
      },
      "decision-options",
    );
    expect(got).toEqual(
      [
        `${d(1)} has 1 option(s) under ## 方案; a choice needs at least two`,
        `${d(2)} no option under ## 方案 is 否决`,
        `${d(3)} option "C。负责人这次没有选，不做。" says neither 采用 nor 否决`,
      ].sort(),
    );
  });

  test("BR-2110: a source line names a URL or relative path and quotes at least eight characters; a placeholder line is not one", () => {
    const got = run(
      {
        "src/check/check.ts": "export function check(",
        ...decision(
          1,
          [
            "1. A：采用。",
            "   - 来源：https://arxiv.org/abs/2310.01798 “struggle to self-correct”",
            "   - 来源：src/check/check.ts:10 “export function check(”",
            "   - <来源：网址或仓库里的文件路径 “原文摘录”>",
            "2. B：否决。",
            "   - 来源：arXiv 上那篇论文",
            "   - 来源：/Users/a/x.ts “some long quote here”",
            "   - 来源：../x.ts “some long quote here”",
            "   - 来源：https://example.com “太短”",
          ].join("\n"),
        ),
      },
      "source-malformed",
    );
    expect(got.map((m) => m.split(": ")[1]!.split(" (want")[0])).toEqual(
      ["- 来源：arXiv 上那篇论文", "- 来源：/Users/a/x.ts “some long quote here”", "- 来源：../x.ts “some long quote here”", "- 来源：https://example.com “太短”"].sort(),
    );
  });
});

describe("source paths", () => {
  const decision = (sources: string) =>
    ({ [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: X\nstatus: proposed\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n${sources}\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n` });
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const findings = (root: string) => check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "source-malformed").map((f) => f.message);
  /** A git repo whose first commit had the `gone` files, deleted again in the second commit that adds `files`. */
  const malformed = (files: Record<string, string>, gone: readonly string[] = []) => {
    const root = repo(Object.fromEntries(gone.map((p) => [p, "export function refund(\n"])));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "old", "--allow-empty"]]) git(root, ...args);
    for (const p of gone) rmSync(join(root, p));
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    git(root, "add", "-A");
    git(root, "commit", "-qm", "now");
    return findings(root);
  };

  test("BR-2110: a source path must be a file of the repository: a word taken as a path, or a directory, is reported; an existing file with a line number is not", () => {
    const file = { "src/billing/refund.ts": "export function refund(" };
    expect(malformed({ ...file, ...decision("   - 来源：src/billing/refund.ts:1 “export function refund(”") })).toEqual([]);
    expect(malformed({ ...file, ...decision("   - 来源：https://example.com/x “export function refund(”") })).toEqual([]);
    const word = malformed({ ...file, ...decision("   - 来源：arXiv “struggle to self-correct”") });
    expect(word).toEqual([`${d(1)}: - 来源：arXiv “struggle to self-correct” (arXiv is not a file in the repository)`]);
    expect(malformed({ ...file, ...decision("   - 来源：src/billing “export function refund(”") })).toHaveLength(1);
  });

  test("BR-2110: a source file git history had is moved, not malformed; a path history never had, or a directory, is reported", () => {
    const old = (line: string) => malformed(decision(line), ["src/old/refund.ts"]);
    expect(old("   - 来源：src/old/refund.ts “export function refund(”")).toEqual([]);
    expect(old("   - 来源：src/old/refund.ts:1 “export function refund(”")).toEqual([]);
    expect(old("   - 来源：src/biling/refund.ts “export function refund(”")).toEqual([
      `${d(1)}: - 来源：src/biling/refund.ts “export function refund(” (src/biling/refund.ts is not a file in the repository)`,
    ]);
    expect(old("   - 来源：refund.ts “export function refund(”")).toHaveLength(1); // only the same path counts, not the same file name
    expect(old("   - 来源：src/old “export function refund(”")).toHaveLength(1); // history had files under it, never the path itself
  });

  test("BR-2110: a missing source path outside a git repository is reported, saying history cannot be read", () => {
    const root = repo(decision("   - 来源：src/old/refund.ts “export function refund(”"));
    const got = findings(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("src/old/refund.ts is not a file in the repository; cannot read git history to check source paths");
  });

  test("BR-2110: a missing source path in a repository with no commit yet is reported", () => {
    const root = repo(decision("   - 来源：src/old/refund.ts “export function refund(”"));
    git(root, "init", "-q", "-b", "main");
    const got = findings(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("src/old/refund.ts is not a file in the repository");
  });
});

describe("source quotes", () => {
  const decision = (status: string, sources: string) =>
    ({ [`canon/decisions/${d(1)}.md`]: `---\nid: ${d(1)}\ntitle: X\nstatus: ${status}\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n${sources}\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n` });
  const quoteFindings = (files: Record<string, string>) => {
    const root = repo(files);
    return check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "source-quote-missing").map((f) => f.message);
  };
  const line = "   - 来源：src/a.ts “export function refund(”";

  test("BR-2252: a current decision's source file that no longer holds its quote is reported, naming the decision, file and quote", () => {
    expect(quoteFindings({ "src/a.ts": "// x\nexport function refund(a) {}\n", ...decision("accepted", line) })).toEqual([]);
    const got = quoteFindings({ "src/a.ts": "export function refundOrder(a) {}\n", ...decision("accepted", line) });
    expect(got).toEqual([`${d(1)}: src/a.ts does not contain “export function refund(” (- 来源：src/a.ts “export function refund(”)`]);
    expect(quoteFindings({ "src/a.ts": "export function refundOrder(a) {}\n", ...decision("proposed", line) })).toHaveLength(1);
  });

  test("BR-2252: the line number is ignored and whitespace collapses as at landing; superseded decisions, URLs and gone files are not checked", () => {
    const file = { "src/a.ts": "\n".repeat(29) + "export\n  function refund(a) {}\n" };
    expect(quoteFindings({ ...file, ...decision("accepted", "   - 来源：src/a.ts:12 “export   function refund(”") })).toEqual([]);
    const changed = { "src/a.ts": "export function refundOrder(a) {}\n" };
    expect(quoteFindings({ ...changed, ...decision("superseded", line) })).toEqual([]);
    expect(quoteFindings({ ...changed, ...decision("accepted", "   - 来源：https://example.com/a “some long quote”") })).toEqual([]);
    expect(quoteFindings(decision("accepted", "   - 来源：src/gone.ts “export function refund(”"))).toEqual([]);
  });

  test("BR-2252: a source that is, or lies under, a symbolic link is not read: the same finding whatever the link points at", () => {
    const outside = mkdtempSync(join(tmpdir(), "canon-outside-"));
    writeFileSync(join(outside, "credentials"), "aws_secret_access_key = AKIA\n");
    const all = (link: string, target: string, source: string) => {
      const root = repo(decision("accepted", `   - 来源：${source}`));
      mkdirSync(join(root, "docs"), { recursive: true });
      symlinkSync(target, join(root, link));
      const got = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule.startsWith("source-"));
      return got.map((f) => `${f.rule} ${f.message.split(" (")[0]}`);
    };
    const linked = (p: string) => [`source-quote-missing ${d(1)}: ${p} is a symbolic link; canon does not follow links, so it was not read`];
    expect(all("docs/k", join(outside, "credentials"), "docs/k “aws_secret_access_key = A”")).toEqual(linked("docs/k"));
    expect(all("docs/k", join(outside, "credentials"), "docs/k “aws_secret_access_key = Z”")).toEqual(linked("docs/k"));
    expect(all("docs/k", join(outside, "nothing-here"), "docs/k “aws_secret_access_key = A”")).toEqual(linked("docs/k"));
    expect(all("vendor", outside, "vendor/credentials “aws_secret_access_key = A”")).toEqual(linked("vendor/credentials"));
  });
});

describe("source verification", () => {
  test("BR-2111: a real HTTP page is fetched and its visible text, not its markup or scripts, must hold the quote", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/p"
          ? new Response("<html><script>var q = 'hidden quote text';</script><p>LLMs struggle to <b>self-correct</b>\n their responses &amp; more</p></html>", { headers: { "content-type": "text/html" } })
          : new Response("gone", { status: 404 }),
    });
    try {
      const at = (path: string, quote: string) => ({ target: `http://localhost:${server.port}${path}`, quote, line: "" });
      const got = await verify(repo({}), [at("/p", "struggle to self-correct their responses & more"), at("/p", "hidden quote text"), at("/x", "struggle to self-correct")]);
      expect(got.map((m) => m.replace(/localhost:\d+/, "host"))).toEqual(["http://host/p does not contain “hidden quote text”", "http://host/x answered HTTP 404"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("id allocation", () => {
  test("BR-2002: never hands out an id at or below the highest one already in the files", () => {
    const root = repo({});
    const db = CoordDb.open(join(root, "state.db"));
    if (!db.ok) throw new Error(db.error.message);
    expect(db.value.allocate("BR", 1562, "test")).toBe(br(1563));
    expect(db.value.allocate("BR", 0, "test")).toBe(br(1564));
    expect(db.value.allocate("D", 0, "test")).toBe(d(1));
    db.value.close();
  });
});

describe("domain code paths", () => {
  test("BR-2079: a code path that does not exist is reported on the README; existing files and directories are fine", () => {
    const root = repo({
      "canon/rules/billing/README.md": "---\ncode: [src/billing, src/gone, src/main.ts]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n",
      "src/main.ts": "export {};\n",
    });
    const findings = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "domain-code-missing");
    expect(findings.map((f) => `${f.path} ${f.message}`)).toEqual(["canon/rules/billing/README.md code path src/gone does not exist; fix it or remove it from the README"]);
  });
});

describe("code layout (D-15)", () => {
  const readme = (name: string, code?: string) => `${code ? `---\ncode: [${code}]\n---\n` : ""}# ${name}\n\n## 术语\n\n- **x**：y\n`;
  const kinds = (root: string, layout?: { codeRoot: string | undefined; shared: string[] }) =>
    check({ root, ...readCorpus(root, undefined, layout), testFiles: [] }).map((f) => `${f.rule} ${f.path}`).sort();

  test("BR-2006: without code_root a subdomain README needs no `code`; with code_root no README does, and front matter is optional", () => {
    const root = repo({ "canon/rules/billing/README.md": readme("billing", "src/billing"), "canon/rules/billing/refunds/README.md": readme("billing/refunds") });
    expect(kinds(root)).toEqual([]);
    const layered = repo({ "canon/rules/billing/README.md": readme("billing"), "canon/rules/billing/refunds/README.md": readme("billing/refunds"), "src/billing/refunds/r.ts": "" });
    expect(kinds(layered, { codeRoot: "src", shared: ["src/auth"] })).toEqual([]);
  });

  test("BR-2117: `code` is reported on a subdomain README, and on every README once code_root is set", () => {
    const root = repo({ "canon/rules/billing/README.md": readme("billing", "src/billing"), "canon/rules/billing/refunds/README.md": readme("billing/refunds", "src/billing") });
    expect(kinds(root)).toEqual(["domain-code-declared canon/rules/billing/refunds/README.md"]);
    mkdirSync(join(root, "src/billing/refunds"), { recursive: true });
    expect(kinds(root, { codeRoot: "src", shared: ["src/auth"] })).toEqual(["domain-code-declared canon/rules/billing/README.md", "domain-code-declared canon/rules/billing/refunds/README.md"]);
  });

  test("BR-2118: with code_root every domain has its directory and every directory at a branching level is a domain's or shared", () => {
    const root = repo({
      "canon/rules/work/README.md": readme("work"),
      "canon/rules/work/land/README.md": readme("work/land"),
      "canon/rules/work/drop/README.md": readme("work/drop"),
      "canon/rules/billing/README.md": readme("billing"),
      "src/work/db.ts": "", // a file in a branching domain's directory is that domain's
      "src/work/land/steps/a.ts": "", // inside a leaf domain the layout is its own
      "src/work/helpers/h.ts": "", // not a subdomain of work
      "src/lib/kernel/git.ts": "", // src/lib is an ancestor of a shared entry
      "src/lib/other/x.ts": "",
      "src/lib/loose.ts": "", // a file in an ancestor of a shared path is nobody's
      "src/__tests__/a.test.ts": "", // tests-only directories get no exemption
      "src/index.ts": "",
      "src/.cache/x": "",
    });
    rmSync(join(root, "src/billing"), { recursive: true });
    expect(kinds(root, { codeRoot: "src", shared: ["src/lib/kernel", "src/gone"] })).toEqual([
      "code-layout canon/config.yaml", // shared src/gone does not exist
      "code-layout canon/rules/billing/README.md",
      "code-layout canon/rules/work/drop/README.md",
      "code-layout src/__tests__",
      "code-layout src/auth", // the fixture's src/auth is no domain
      "code-layout src/index.ts",
      "code-layout src/lib/loose.ts",
      "code-layout src/lib/other",
      "code-layout src/work/helpers",
    ]);
    expect(kinds(root).filter((k) => k.startsWith("code-layout"))).toEqual([]); // no code_root: none of the above is reported
    expect(kinds(root, { codeRoot: "src", shared: ["src/lib/kernel", "src/gone", "src/index.ts"] })).not.toContain("code-layout src/index.ts"); // a shared file
    const overlap = (shared: string[]) => check({ root, ...readCorpus(root, undefined, { codeRoot: "src", shared }), testFiles: [] }).filter((f) => f.message.includes("overlaps")).map((f) => f.message);
    expect(overlap(["src/work"])).toEqual(["work", "work/drop", "work/land"].map((n) => `shared path src/work overlaps the directory src/${n} of domain ${n}`));
    expect(overlap(["src/work/land/k"])).toEqual(["shared path src/work/land/k overlaps the directory src/work of domain work", "shared path src/work/land/k overlaps the directory src/work/land of domain work/land"]);
    expect(overlap(["src/lib/kernel"])).toEqual([]);
  });
});

describe("backticked repository paths", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  /** A git repo whose history had src/old.ts, src/coord/db.ts and src/lib/state.ts, all since deleted; src/kernel/git.ts stays. */
  function moved(files: Record<string, string>): string {
    const root = repo({ "src/old.ts": "x\n", "src/coord/db.ts": "x\n", "src/lib/state.ts": "x\n", "src/kernel/git.ts": "x\n" });
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-qm", "old"]]) sh(root, ...args);
    for (const p of ["src/old.ts", "src/coord", "src/lib"]) rmSync(join(root, p), { recursive: true });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "moved");
    return root;
  }
  const missing = (root: string) =>
    check({ root, ...readCorpus(root), testFiles: [] })
      .filter((f) => f.rule === "path-missing")
      .map((f) => `${f.path}: ${f.message.match(/`([^`]+)`/)![1]}`);
  const rule = (body: string, status = "active") => `---\nid: ${br(1)}\ntitle: R\nstatus: ${status}\nuntested: fixture\n---\n${body}`;
  const decision = (status: string, body: string) => `---\nid: ${d(1)}\ntitle: X\nstatus: ${status}\n---\n${body}`;
  const change = (status: string) => `---\nid: ${["C", 1].join("-")}\ntitle: X\nstatus: ${status}\nrules: []\n---\n## 为什么\n\nSee \`src/old.ts\`.\n\n## 要改什么\n\nNew \`src/work/remote/\`.\n\n## 任务\n\n- [ ] x\n`;

  test("BR-2171: a moved or deleted path in a root doc or a README is reported; a path that never existed, an existing one or a non-path is not", () => {
    const root = moved({
      "CLAUDE.md": "Code in `src/coord`, see `src/kernel/git.ts:12`. Not paths: `src/<领域>/x.ts`, `src/**/*.test.ts`, `.ts`, `https://x.dev/src/old.ts`.\n\n```\n`src/old.ts`\n```\n\nPlain src/old.ts.\n",
      "README.md": "Old `state.ts`. Never existed: `src/billing`, `nothing.ts`.\n",
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# Billing\n\nOld code in `src/old.ts`.\n\n## 术语\n\n- **退款**：钱退回\n",
    });
    expect(missing(root).sort()).toEqual(["CLAUDE.md: src/coord", "README.md: state.ts", "canon/rules/billing/README.md: src/old.ts"]);
  });

  test("BR-2171: rule examples, decision background and options, closed changes and superseded decisions are history", () => {
    const at = (files: Record<string, string>) => missing(moved({ "canon/rules/billing/README.md": domainReadme, ...files }));
    expect(at({ [`canon/rules/billing/${br(1)}.md`]: rule("## 规则\n\nx\n\n## 例子\n\n- `src/old.ts` → y\n") })).toEqual([]);
    expect(at({ [`canon/rules/billing/${br(1)}.md`]: rule("## 规则\n\nReads `src/old.ts`.\n\n## 例子\n\n- a → b\n") })).toEqual([`canon/rules/billing/${br(1)}.md: src/old.ts`]);
    expect(at({ [`canon/rules/billing/${br(1)}.md`]: rule("## 规则\n\nReads `src/old.ts`.\n", "retired") })).toEqual([]);
    const body = (where: string) => ["背景", "方案", "决定", "后果"].map((s) => `## ${s}\n\n${s === where ? "Moved `src/old.ts`." : "x"}\n`).join("\n");
    expect(at({ [`canon/decisions/${d(1)}.md`]: decision("accepted", body("背景")) })).toEqual([]);
    expect(at({ [`canon/decisions/${d(1)}.md`]: decision("accepted", body("方案")) })).toEqual([]);
    expect(at({ [`canon/decisions/${d(1)}.md`]: decision("accepted", body("决定")) })).toEqual([`canon/decisions/${d(1)}.md: src/old.ts`]);
    expect(at({ [`canon/decisions/${d(1)}.md`]: decision("superseded", body("决定")) })).toEqual([]);
    expect(at({ "canon/changes/C-1.md": change("open") })).toEqual(["canon/changes/C-1.md: src/old.ts"]); // the planned src/work/remote is not reported
    expect(at({ "canon/changes/C-1.md": change("done") })).toEqual([]);
    expect(at({ "canon/changes/C-1.md": change("dropped") })).toEqual([]);
    expect(at({ "canon/notes/N-1.md": `---\nid: ${["N", 1].join("-")}\ntitle: X\n---\nWas \`src/old.ts\`.\n` })).toEqual([]);
  });

  test("BR-2186: symbolic links are not followed, so dangling links and loops do not crash check", () => {
    const root = moved({
      "CLAUDE.md": "See `src/dangling` and `link.ts`.\n",
      "canon/config.yaml": 'tests: ["src/**/*.test.ts"]\n',
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: ruleFile(1),
      "src/r.test.ts": "x\n",
    });
    symlinkSync("nowhere", join(root, "src/dangling"));
    symlinkSync("nowhere", join(root, "dangling-top"));
    symlinkSync(".", join(root, "src/loop"));
    symlinkSync("r.test.ts", join(root, "src/l.test.ts"));
    symlinkSync("src/r.test.ts", join(root, "link.ts"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "links");
    const config = readConfig(root);
    expect(config.ok && testFilesFor(root, config.value)).toEqual({ ok: true, value: ["src/r.test.ts"] });
    expect(check(withReports(root, reportsOf({ "src/r.test.ts": [tc(br(1))] }))).map((f) => `${f.rule} ${f.path}`)).toEqual([]);
  });

  test("BR-2171: a missing candidate path outside a git repository is reported once as unreadable history; existing ones need no history", () => {
    const root = repo({ "CLAUDE.md": "See `src/old.ts`.\n", "README.md": "See `src/old.ts`.\n" });
    const f = check({ root, ...readCorpus(root), testFiles: [] }).filter((x) => x.rule === "path-missing");
    expect(f.map((x) => `${x.path} ${x.message.split(":")[0]}`)).toEqual(["CLAUDE.md cannot read git history to check backticked paths"]);
    const present = repo({ "CLAUDE.md": "See `src/billing` and `src/auth/`.\n" });
    expect(check({ root: present, ...readCorpus(present), testFiles: [] }).filter((x) => x.rule === "path-missing")).toEqual([]);
  });

  test("BR-2171: a repository with no commit yet has no moved paths", () => {
    const root = repo({ "CLAUDE.md": "See `src/old.ts`.\n" });
    sh(root, "init", "-q", "-b", "main");
    expect(check({ root, ...readCorpus(root), testFiles: [] }).filter((x) => x.rule === "path-missing")).toEqual([]);
  });

  test("BR-2171: backtick and tilde fences are code blocks, and a `## ` line inside one is no section heading", () => {
    const root = moved({
      "CLAUDE.md": "~~~\n`src/old.ts`\n~~~\n\n````md\n```\n`src/coord`\n```\n````\n",
      "canon/rules/billing/README.md": domainReadme,
      [`canon/rules/billing/${br(1)}.md`]: rule("## 规则\n\nx\n\n```\n## 例子\n```\n\nReads `src/old.ts`.\n\n## 例子\n\n~~~\n## 规则\n~~~\n\n- `src/coord` → y\n"),
    });
    expect(missing(root)).toEqual([`canon/rules/billing/${br(1)}.md: src/old.ts`]);
  });
});
