import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { watch } from "../../watch/watch.ts";

// reason: these tests land a change through the spawned CLI, which waits out queue polls (C-111).
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");

async function canonIn(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};

const tc = (name: string, file?: string, skipped = false) => `<testcase name="${name}" classname=""${file === undefined ? "" : ` file="${file}"`}${skipped ? "><skipped /></testcase>" : " />"}`;
const report = (...cases: string[]) => `<testsuites><testsuite name="all">${cases.join("")}</testsuite></testsuites>`;

/** A project whose floor copies report.xml, a file of the tree, to {report}, then exits with the number in floor-exit (0 when there is none). */
function fixture(reportText: string, floorCommand = "sh f.sh {report}") {
  const root = project();
  write(root, {
    "canon/config.yaml": `floor: "${floorCommand}"\ntests: ["src/**/*.test.ts"]\nreview: none\n`,
    "f.sh": '[ -e skip-report ] || cp report.xml "$1"\nexit $(cat floor-exit 2>/dev/null || echo 0)\n',
    "src/a.test.ts": "a\n",
    "src/b.test.ts": "b\n",
    "scripts/x.ts": "x\n",
    "report.xml": reportText,
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  const wt = startNew(root, "floor report").worktree;
  write(wt, { "README.md": "change\n" });
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "change");
  return { root, wt };
}

const rows = (root: string) =>
  ws(root).db.db.query<{ path: string; blob: string; cases: string; source: string }, []>("SELECT path, blob, cases, source FROM test_reports ORDER BY path").all();

/** The text of the log the refusal names. */
const logOf = (err: string) => readFileSync(err.match(/full log: ([^)]+)\)/)![1]!, "utf8");

describe("the floor's report is recorded per test file", () => {
  test("BR-2339: a landing whose floor writes a report with file on each testcase records one row per matching test file, from the landed tree", async () => {
    const { root, wt } = fixture(report(tc("BR-1: x", "src/a.test.ts"), tc("BR-2: y", "src/a.test.ts", true), tc("BR-3: z", "src/b.test.ts"), tc("other", "scripts/x.ts")));
    const r = await canonIn(wt, "work", "land");
    expect(r.code).toBe(0);
    const got = rows(root);
    expect(got.map((x) => [x.path, x.source, x.blob])).toEqual([
      ["src/a.test.ts", "floor", sh(root, "rev-parse", "main:src/a.test.ts")],
      ["src/b.test.ts", "floor", sh(root, "rev-parse", "main:src/b.test.ts")],
    ]);
    expect(JSON.parse(got[0]!.cases).map((c: { name: string; runs: boolean }) => [c.name, c.runs])).toEqual([["BR-1: x", true], ["BR-2: y", false]]);
  }, TIMED);

  test("BR-2339: a floor that passes without writing the report refuses the landing and the log says so", async () => {
    const { root, wt } = fixture(report());
    write(wt, { "skip-report": "x\n" });
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "no report");
    const r = await canonIn(wt, "work", "land");
    expect(r.code).toBe(1);
    expect(r.err).toContain("floor exited 1");
    expect(logOf(r.err)).toContain("the floor wrote no report");
    expect(rows(root)).toEqual([]);
  }, TIMED);

  test("BR-2339: a testcase without file refuses the landing, names the way out and records nothing", async () => {
    const { root, wt } = fixture(report(tc("BR-1: x", "src/a.test.ts"), tc("BR-2: y")));
    const r = await canonIn(wt, "work", "land");
    expect(r.code).toBe(1);
    const log = logOf(r.err);
    expect(log).toContain("has no file attribute");
    expect(log).toContain("canon work test --all");
    expect(rows(root)).toEqual([]);
  }, TIMED);

  test("BR-2339: a file outside the repository and a report that is not XML refuse the landing", async () => {
    const outside = fixture(report(tc("BR-1: x", "/etc/passwd")));
    const a = await canonIn(outside.wt, "work", "land");
    expect(a.code).toBe(1);
    expect(logOf(a.err)).toContain("outside the repository");
    const broken = fixture("this is not xml");
    const b = await canonIn(broken.wt, "work", "land");
    expect(b.code).toBe(1);
    expect(logOf(b.err)).toContain("not valid XML");
    expect(rows(outside.root).concat(rows(broken.root))).toEqual([]);
  }, TIMED);

  test("BR-2339: a floor that fails keeps its exit code, and the report problem is only in the log", async () => {
    const { wt } = fixture(report());
    write(wt, { "floor-exit": "3\n", "skip-report": "x\n" });
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "failing floor");
    const r = await canonIn(wt, "work", "land");
    expect(r.code).toBe(1);
    expect(r.err).toContain("floor exited 3");
  }, TIMED);

  test("BR-2339: a floor without {report} lands as before and records nothing", async () => {
    const { root, wt } = fixture(report(tc("BR-1: x", "src/a.test.ts")), "true");
    const r = await canonIn(wt, "work", "land");
    expect(r.code).toBe(0);
    expect(rows(root)).toEqual([]);
  }, TIMED);

  test("BR-2339: the background floor of floor_timing after records the report of the main it tested", async () => {
    const root = project();
    write(root, {
      "canon/config.yaml": 'floor: "sh f.sh {report}"\ntests: ["src/**/*.test.ts"]\nreview: none\nfloor_timing: after\nfloor_quiet_minutes: 0\n',
      "f.sh": 'cp report.xml "$1"\n',
      "src/a.test.ts": "a\n",
      "report.xml": report(tc("BR-1: x", "src/a.test.ts")),
    });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fixture");
    const r = await watch(ws(root), quiet);
    expect(r.ok).toBe(true);
    expect(rows(root).map((x) => [x.path, x.source, x.blob])).toEqual([["src/a.test.ts", "floor", sh(root, "rev-parse", "main:src/a.test.ts")]]);
  }, TIMED);
});
