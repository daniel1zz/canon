import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseNames, parseJUnit, readReport, type TestCase } from "./report.ts";

// Verified against real output: bun.xml is what `bun test c.test.ts d.test.ts --reporter=junit --reporter-outfile=…` wrote
// (bun 1.4.4); pytest-xunit2.xml, pytest-xunit1.xml and gdunit4.xml are the shapes D-64 recorded from pytest 8.4.2 and gdUnit4 6.2.3.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "reports", name), "utf8");
const cases = (name: string): TestCase[] => {
  const r = parseJUnit(fixture(name));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const byName = (all: TestCase[], name: string) => all.find((c) => c.name === name)!;

describe("JUnit reports: what each testcase says", () => {
  test("BR-2338: a bun report gives every testcase its suites, class, name, line and whether it runs", () => {
    const all = cases("bun.xml");
    expect(all.length).toBe(7);
    expect(byName(all, "first")).toEqual({ suites: ["c.test.ts", "BR-1"], classname: "BR-1", name: "first", runs: true, line: 4, file: "c.test.ts" });
    expect(byName(all, "plain").suites).toEqual(["d.test.ts"]);
    expect(byName(all, "plain").line).toBe(2);
  });

  test("BR-2338: skip, todo and each: skipped and todo do not run, each group is its own testcase, a failure still runs", () => {
    const all = cases("bun.xml");
    expect(byName(all, "second").runs).toBe(false);
    expect(byName(all, "BR-2: later").runs).toBe(false);
    expect(all.filter((c) => c.name.startsWith("BR-3: each")).map((c) => [c.name, c.runs])).toEqual([["BR-3: each one", true], ["BR-3: each two", true]]);
    expect(byName(all, "BR-4: fails").runs).toBe(true);
  });

  test("BR-2338: a rule id written only in a comment is in no testcase, an id in a describe name names the tests under it", () => {
    const all = cases("bun.xml");
    expect(all.some((c) => caseNames(c).includes("only in a comment"))).toBe(false);
    expect(caseNames(byName(all, "first"))).toContain("BR-1");
    expect(caseNames(byName(all, "plain"))).not.toContain("BR-1");
  });

  test("BR-2338: a pytest xunit2 report has only classname and name: read as they are, no line", () => {
    const all = cases("pytest-xunit2.xml");
    expect(all.length).toBe(5);
    expect(all.every((c) => c.line === undefined && c.file === undefined)).toBe(true);
    expect(byName(all, "test_param[BR-5-one]")).toMatchObject({ classname: "tools.tests.tmp_pytest_test.TestGroup", runs: true, suites: ["pytest"] });
    expect(byName(all, "test_skipped").runs).toBe(false);
    expect(byName(all, "test_runtime_skip").runs).toBe(false);
    expect(byName(all, "test_BR_6_fails").runs).toBe(true);
  });

  test("BR-2338: a pytest xunit1 report adds line, which starts at 0 and is used as written", () => {
    const all = cases("pytest-xunit1.xml");
    expect(all.map((c) => c.line)).toEqual([8, 12]);
    expect(all.map((c) => c.file)).toEqual(["tools/tests/tmp_pytest_test.py", "tools/tests/tmp_pytest_test.py"]);
  });

  test("BR-2338: a gdUnit4 report has no file and no line, a skipped test has a skipped child", () => {
    const all = cases("gdunit4.xml");
    expect(all.map((c) => [c.name, c.runs, c.line, c.file])).toEqual([
      ["test_passes", true, undefined, undefined],
      ["test_plain_passes", true, undefined, undefined],
      ["test_BR_3_disabled", false, undefined, undefined],
      ["test_BR_4_fails", true, undefined, undefined],
    ]);
    expect(all[0]!.suites).toEqual(["tmp_junit_test"]);
  });

  test("BR-2338: line counts only when it is a whole number", () => {
    const r = parseJUnit('<testsuite name="s"><testcase name="a" line="x" /><testcase name="b" line="-1" /><testcase name="c" line="7" /></testsuite>');
    expect(r.ok && r.value.map((c) => c.line)).toEqual([undefined, undefined, 7]);
  });

  test("BR-2338: entities, CDATA and comments in a report are read without changing which testcases there are", () => {
    const r = parseJUnit('<?xml version="1.0"?><!-- c --><testsuites><testsuite name="a &amp; b"><testcase name="x &lt; y &#65;" classname=\'k\'><failure><![CDATA[</testcase>]]></failure></testcase></testsuite></testsuites>');
    expect(r.ok && r.value).toEqual([{ suites: ["a & b"], classname: "k", name: "x < y A", runs: true }]);
  });
});

describe("JUnit reports: the ones canon refuses", () => {
  test("BR-2338: a report without testcases is valid and empty", () => {
    expect(parseJUnit("<testsuites></testsuites>")).toEqual({ ok: true, value: [] });
    expect(parseJUnit('<testsuite name="x" tests="0"/>')).toEqual({ ok: true, value: [] });
  });

  test("BR-2338: a root that is neither testsuites nor testsuite is refused and named", () => {
    const r = parseJUnit("<html><body/></html>");
    expect(!r.ok && r.error.message).toContain("<html>");
  });

  test("BR-2338: text that is not XML, an unclosed tag, a mismatched tag and an unknown entity are refused", () => {
    for (const bad of ["", "not xml", "<testsuites>", "<testsuites><testsuite></testsuites>", '<testsuite name="x><testcase/></testsuite>', "<testsuite><testcase name='&bogus;'/></testsuite>", "<testsuite/><testsuite/>"]) {
      const r = parseJUnit(bad);
      expect(r.ok).toBe(false);
    }
  });

  test("BR-2338: a DOCTYPE that defines entities is refused, a plain one is skipped", () => {
    expect(parseJUnit('<!DOCTYPE x [<!ENTITY y "z">]><testsuites/>').ok).toBe(false);
    expect(parseJUnit("<!DOCTYPE testsuites><testsuites/>").ok).toBe(true);
  });

  test("BR-2338: a missing report is not_found and a file that is not a report is invalid", () => {
    const dir = import.meta.dir;
    const missing = readReport(join(dir, "reports", "nope.xml"));
    expect(!missing.ok && missing.error.code).toBe("not_found");
    const file = join(mkdtempSync(join(tmpdir(), "canon-report-")), "r.xml");
    writeFileSync(file, "hello");
    const bad = readReport(file);
    expect(!bad.ok && bad.error.code).toBe("invalid");
  });
});
