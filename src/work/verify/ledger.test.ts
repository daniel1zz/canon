import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";
import { lastReport, recordReport, reportFor, ROWS_PER_PATH } from "./ledger.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

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

const suite = (...names: string[]) => `<testsuite name="s">${names.map((n) => n.startsWith("!") ? `<testcase name="${n.slice(1)}" classname=""><skipped /></testcase>` : `<testcase name="${n}" classname="" line="3" />`).join("")}</testsuite>`;

/** A project whose test files are their own JUnit reports: run.sh copies the file to {report}, and exits 1 when it holds FAILME. */
function fixture(testCommand = "sh run.sh {file} {report}") {
  const root = project();
  write(root, {
    "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "${testCommand}"\n`,
    "run.sh": 'cp "$1" "$2" 2>/dev/null\nif grep -q FAILME "$1"; then echo "boom in $1"; exit 1; fi\n',
    "src/a.test.ts": suite("seven: x"),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return startNew(root, "ledger").worktree;
}

const rows = (wt: string) =>
  ws(wt).db.db.query<{ path: string; blob: string; cases: string; source: string }, []>("SELECT path, blob, cases, source FROM test_reports ORDER BY id").all();

describe("canon work test records the reports its test_command writes", () => {
  test("BR-2337: a run records the file's blob hash and testcases, a changed file adds a row and keeps the old one", () => {
    const wt = fixture();
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(0);
    const first = rows(wt);
    expect(first.length).toBe(1);
    expect(first[0]!.path).toBe("src/a.test.ts");
    expect(first[0]!.blob).toBe(sh(wt, "hash-object", "src/a.test.ts"));
    expect(first[0]!.source).toBe("test_command");
    expect(JSON.parse(first[0]!.cases)).toEqual([{ suites: ["s"], classname: "", name: "seven: x", runs: true, line: 3 }]);
    write(wt, { "src/a.test.ts": suite("seven: x", "eight: y") });
    expect(canon(wt, "work", "test", "--all").code).toBe(0);
    const second = rows(wt);
    expect(second.map((x) => x.blob)).toEqual([first[0]!.blob, sh(wt, "hash-object", "src/a.test.ts")]);
  });

  test("BR-2337: the same content run twice is still one row", () => {
    const wt = fixture();
    expect(canon(wt, "work", "test", "--all").code).toBe(0);
    expect(canon(wt, "work", "test", "--all").code).toBe(0);
    expect(rows(wt).length).toBe(1);
  });

  test("BR-2337: only the newest rows of a path are kept", () => {
    const wt = fixture();
    const db = ws(wt).db;
    for (let i = 0; i < ROWS_PER_PATH + 1; i++) recordReport(db, "src/a.test.ts", `blob${i}`, [], "test_command");
    expect(rows(wt).map((x) => x.blob)).toEqual(["blob1", "blob2", "blob3", "blob4", "blob5"]);
    expect(reportFor(db, "src/a.test.ts", "blob0")).toBeUndefined();
    expect(lastReport(db, "src/a.test.ts")?.blob).toBe("blob5");
    recordReport(db, "src/other.test.ts", "x", [], "floor");
    expect(rows(wt).length).toBe(ROWS_PER_PATH + 1);
  });

  test("BR-2337: a failing test with a skipped testcase exits 1 and is still recorded, the skipped one not running", () => {
    const wt = fixture();
    write(wt, { "src/a.test.ts": `${suite("seven: x", "!nine: later")}<!-- FAILME -->` });
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(1);
    expect(r.out).toContain("boom in src/a.test.ts");
    const recorded = rows(wt);
    expect(recorded.length).toBe(1);
    expect(JSON.parse(recorded[0]!.cases).map((c: { name: string; runs: boolean }) => [c.name, c.runs])).toEqual([["seven: x", true], ["nine: later", false]]);
  });

  test("BR-2337: a command that writes no report fails with the file named and records nothing", () => {
    const wt = fixture("sh run.sh {file} /nonexistent/dir/report.xml && true; true {report}");
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/a.test.ts: the test command wrote no report");
    expect(rows(wt)).toEqual([]);
  });

  test("BR-2337: a report that is not XML fails, a failing command keeps its own exit code, nothing is recorded", () => {
    const wt = fixture();
    write(wt, { "src/a.test.ts": "plain text, not xml" });
    const r = canon(wt, "work", "test", "--all");
    expect(r.code).toBe(1);
    expect(r.out).toContain("the report is not valid JUnit XML");
    write(wt, { "run.sh": 'cp "$1" "$2"\nexit 3\n' });
    const again = canon(wt, "work", "test", "--all");
    expect(again.out).toContain("(exit 3)");
    expect(rows(wt)).toEqual([]);
  });

  test("BR-2337: without {report} in test_command nothing is recorded and the run is unchanged", () => {
    const wt = fixture("sh run.sh {file}");
    expect(canon(wt, "work", "test", "--all").code).toBe(0);
    expect(rows(wt)).toEqual([]);
  });
});
