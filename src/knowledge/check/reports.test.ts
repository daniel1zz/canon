import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew, ws } from "../../work/testkit.ts";
import { recordReport } from "../../work/verify/ledger.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const br = (n: number) => ["BR", n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};

/** BR-1 and BR-2 live in billing; a.test.ts and b.test.ts are test files whose reports the test records itself. */
function fixture() {
  const root = project();
  const rule = (n: number) => `---\nid: ${br(n)}\ntitle: Rule ${n}\nstatus: active\n---\n\n## 规则\n\nS${n}.\n\n## 例子\n\n- a → b\n`;
  write(root, {
    "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\nreview: none\n',
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **x**：y\n",
    [`canon/rules/billing/${br(1)}.md`]: rule(1),
    [`canon/rules/billing/${br(2)}.md`]: rule(2),
    "src/billing/a.test.ts": "a\n",
    "src/billing/b.test.ts": "b\n",
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  const record = (dir: string, file: string, ...names: string[]) =>
    recordReport(ws(root).db, file, sh(dir, "hash-object", file), names.map((name) => ({ suites: [], classname: "", name, runs: true })), "test_command");
  return { root, record };
}

describe("canon check reads the ledger of test reports", () => {
  test("BR-2005: rules are tested by what the reports name; a file never reported leaves its rules untested and the message says to run canon work test --all", () => {
    const { root, record } = fixture();
    record(root, "src/billing/a.test.ts", `${br(1)}: x`);
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`rule-untested`);
    expect(r.out).toContain(`${br(2)} has no running test whose name names it`);
    expect(r.out).toContain("1 test file(s) have no report: run canon work test --all");
    expect(r.out).not.toContain(`${br(1)} has no`);
    record(root, "src/billing/b.test.ts", `${br(2)}: y`);
    expect(canon(root, "check").code).toBe(0);
  });

  test("BR-2344: in a change, a changed test file without a report for its content is one finding with the command; after the report it is not", () => {
    const { root, record } = fixture();
    record(root, "src/billing/a.test.ts", `${br(1)}: x`);
    record(root, "src/billing/b.test.ts", `${br(2)}: y`);
    const wt = startNew(root, "touch a").worktree;
    expect(canon(wt, "check").code).toBe(0);
    write(wt, { "src/billing/a.test.ts": "a changed\n" });
    const missing = canon(wt, "check");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("test-report-missing");
    expect(missing.out).toContain("run canon work test src/billing/a.test.ts");
    expect(missing.out).toContain(`${br(1)} has no running test`); // a's older report is not read for a file this change touched (BR-2005)
    record(wt, "src/billing/a.test.ts", `${br(1)}: x`);
    expect(canon(wt, "check").code).toBe(0);
  });

  test("BR-2344: in the main checkout a test file without a report for its content is not a finding", () => {
    const { root, record } = fixture();
    record(root, "src/billing/a.test.ts", `${br(1)}: x`);
    record(root, "src/billing/b.test.ts", `${br(2)}: y`);
    write(root, { "src/billing/a.test.ts": "a changed on main\n" });
    const r = canon(root, "check");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("test-report-missing");
  });

  test("BR-2345: a test file changed by someone else, which this change does not touch, is a note on standard error and the check passes", () => {
    const { root, record } = fixture();
    record(root, "src/billing/a.test.ts", `${br(1)}: x`);
    record(root, "src/billing/b.test.ts", `${br(2)}: y`);
    const wt = startNew(root, "elsewhere").worktree;
    write(root, { "src/billing/a.test.ts": "changed on main by another change\n" });
    sh(root, "commit", "-qam", "another change landed");
    sh(wt, "rebase", "-q", "main");
    const r = canon(wt, "check");
    expect(r.code).toBe(0);
    expect(r.err).toContain("note: src/billing/a.test.ts: 1 test file(s) changed since their last report (src/billing/a.test.ts)");
  });

  test("BR-2344: a test file whose newest report names a rule this change touches needs a current report", () => {
    const { root, record } = fixture();
    record(root, "src/billing/a.test.ts", `${br(1)}: x`);
    record(root, "src/billing/b.test.ts", `${br(2)}: y`);
    const wt = startNew(root, "touch the rule").worktree;
    write(root, { "src/billing/a.test.ts": "changed on main by another change\n" });
    sh(root, "commit", "-qam", "another change landed");
    sh(wt, "rebase", "-q", "main");
    expect(canon(wt, "check").code).toBe(0);
    write(wt, { [`canon/rules/billing/${br(1)}.md`]: `---\nid: ${br(1)}\ntitle: Rule 1\nstatus: active\n---\n\n## 规则\n\nS1 changed.\n\n## 例子\n\n- a → b\n` });
    const r = canon(wt, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("test-report-missing");
    expect(r.out).toContain("src/billing/a.test.ts");
  });
});
