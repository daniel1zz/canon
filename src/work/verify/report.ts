import { readFileSync, statSync } from "node:fs";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Reading a JUnit XML test report (BR-2338, D-64). canon knows no test language: what tests a file holds and whether they
 * ran is what the project's own test framework wrote into the report.
 */

/** Where `test_command` and `floor` take the path of the report the command writes (BR-2160, BR-2339). */
export const REPORT_PLACEHOLDER = "{report}";

/**
 * How each test framework writes a JUnit XML report (D-64): what a project puts in `test_command` (and, where the report has
 * a `file` on every testcase, in `floor`). The framework's own documentation is the source; none of this is read by canon.
 */
export const REPORT_RECIPES = [
  "test_command writes the framework's JUnit XML report to {report}; per framework:",
  "  bun:      test_command: \"bun test {file} --reporter=junit --reporter-outfile={report}\"",
  "  pytest:   test_command: \"pytest {file} -o junit_family=xunit1 --junit-xml={report}\" (xunit1 adds file and line to each testcase; the default xunit2 has neither)",
  "  go:       gotestsum writes it (`gotestsum --junitfile {report}`; go test itself cannot), one package per run, so {file} must name the one file's tests",
  "  vitest:   its junit reporter, with the output file set to {report}",
  "  jest:     the jest-junit reporter, with its output file set to {report}",
  "  Godot (GUT, gdUnit4): a wrapper script that runs the file and copies the framework's JUnit XML to {report}; testcase names must carry the rule ids",
].join("\n");

/** What `canon update` tells a project once it has installed a canon that reads test reports (D-64). */
export const REPORT_UPDATE_NOTE = [
  "note: canon now reads JUnit test reports (D-64): canon/config.yaml needs `tests` (the globs of the test files) and a `test_command` with {file} and {report}; floor_skip_paths wants a test_select_command that says which tests read those paths.",
  REPORT_RECIPES,
].join("\n");

/** A report larger than this is refused, not read: it is untrusted input (D-64). */
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;

/** One `testcase` of a report, as far as canon reads it. */
export interface TestCase {
  /** The `name` of every `testsuite` around it, outermost first. */
  readonly suites: readonly string[];
  readonly classname: string;
  readonly name: string;
  /** False when the `testcase` has a `skipped` child; a failed or errored test still ran. */
  readonly runs: boolean;
  /** The `line` attribute, when it is a whole number. */
  readonly line?: number;
  /** The `file` attribute, when there is one. */
  readonly file?: string;
}

/** The text a test's rule ids are read from: its suites, class and name. */
export const caseNames = (c: TestCase): string => [...c.suites, c.classname, c.name].join("\n");

interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string, where: string): Result<string> {
  let bad: string | undefined;
  const out = text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body: string) => {
    if (body.startsWith("#")) {
      const n = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) {
        bad = m;
        return m;
      }
      return String.fromCodePoint(n);
    }
    const e = ENTITIES[body];
    if (e === undefined) bad = m;
    return e ?? m;
  });
  return bad ? err("invalid", `unknown entity ${bad} in ${where}`) : ok(out);
}

/**
 * A small XML reader: elements, attributes, text, CDATA, comments and processing instructions. It checks that tags
 * match and that quotes close, and refuses a DOCTYPE with an internal subset, so no entity is ever defined by the file.
 */
function parseXml(text: string): Result<XmlNode> {
  const NAME = /[^\s/>=<"']+/y;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let i = 0;
  const fail = (msg: string) => err("invalid", `${msg} (at character ${i})`);
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      if (text.slice(i).trim() !== "") return fail(stack.length ? "text after the end of the file's last tag" : "text outside the root element");
      break;
    }
    const between = text.slice(i, lt);
    if (stack.length === 0 && between.trim() !== "") return fail("text outside the root element");
    if (between.includes("&")) {
      const d = decode(between, "text");
      if (!d.ok) return d;
    }
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return fail("comment is never closed");
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", i)) {
      if (stack.length === 0) return fail("CDATA outside the root element");
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) return fail("CDATA is never closed");
      i = end + 3;
    } else if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) return fail("processing instruction is never closed");
      i = end + 2;
    } else if (text.startsWith("<!", i)) {
      if (stack.length > 0 || root) return fail("DOCTYPE inside the document");
      const end = text.indexOf(">", i);
      if (end < 0 || text.slice(i, end).includes("[")) return fail("a DOCTYPE with an internal subset is not read");
      i = end + 1;
    } else if (text.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      const open = stack.pop();
      if (!m || !open || m[0] !== open.name) return fail(`closing tag </${m?.[0] ?? ""}> does not match ${open ? `<${open.name}>` : "any open tag"}`);
      i = NAME.lastIndex;
      while (/\s/.test(text[i] ?? "")) i++;
      if (text[i] !== ">") return fail(`closing tag </${open.name} is not closed`);
      i++;
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(text);
      if (!m) return fail("a < that starts no tag");
      const attrs: Record<string, string> = {};
      i = NAME.lastIndex;
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(text[i] ?? "")) i++;
        const c = text[i];
        if (c === undefined) return fail(`tag <${m[0]}> is never closed`);
        if (c === ">") {
          i++;
          break;
        }
        if (c === "/") {
          if (text[i + 1] !== ">") return fail(`tag <${m[0]}> has a stray /`);
          selfClosing = true;
          i += 2;
          break;
        }
        NAME.lastIndex = i;
        const a = NAME.exec(text);
        if (!a) return fail(`tag <${m[0]}> has an attribute with no name`);
        i = NAME.lastIndex;
        while (/\s/.test(text[i] ?? "")) i++;
        if (text[i] !== "=") return fail(`attribute ${a[0]} of <${m[0]}> has no value`);
        i++;
        while (/\s/.test(text[i] ?? "")) i++;
        const q = text[i];
        if (q !== '"' && q !== "'") return fail(`attribute ${a[0]} of <${m[0]}> is not quoted`);
        const close = text.indexOf(q, i + 1);
        if (close < 0) return fail(`attribute ${a[0]} of <${m[0]}> is never closed`);
        const v = decode(text.slice(i + 1, close), `attribute ${a[0]}`);
        if (!v.ok) return v;
        if (a[0] in attrs) return fail(`attribute ${a[0]} of <${m[0]}> is repeated`);
        attrs[a[0]] = v.value;
        i = close + 1;
      }
      const node: XmlNode = { name: m[0], attrs, children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) return fail("more than one root element");
      else root = node;
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length) return err("invalid", `<${stack[stack.length - 1]!.name}> is never closed`);
  return root ? ok(root) : err("invalid", "no root element");
}

/** The `testcase`s of a JUnit XML report. An empty report (no `testcase`) is valid; a file that is not XML, or whose root is neither `testsuites` nor `testsuite`, is not. */
export function parseJUnit(text: string): Result<TestCase[]> {
  const root = parseXml(text);
  if (!root.ok) return err("invalid", `not valid XML: ${root.error.message}`);
  if (root.value.name !== "testsuites" && root.value.name !== "testsuite") {
    return err("invalid", `the root element is <${root.value.name}>, not <testsuites> or <testsuite>`);
  }
  const cases: TestCase[] = [];
  const walk = (node: XmlNode, suites: readonly string[]) => {
    for (const child of node.children) {
      if (child.name === "testsuite") walk(child, [...suites, child.attrs["name"] ?? ""]);
      else if (child.name === "testsuites") walk(child, suites);
      else if (child.name === "testcase") {
        const line = child.attrs["line"];
        const file = child.attrs["file"];
        cases.push({
          suites,
          classname: child.attrs["classname"] ?? "",
          name: child.attrs["name"] ?? "",
          runs: !child.children.some((c) => c.name === "skipped"),
          ...(line !== undefined && /^[0-9]+$/.test(line.trim()) ? { line: Number(line) } : {}),
          ...(file !== undefined && file !== "" ? { file } : {}),
        });
      }
    }
  };
  walk(root.value, root.value.name === "testsuite" ? [root.value.attrs["name"] ?? ""] : []);
  return ok(cases);
}

/** Reads the report file at `path`: `not_found` when the command wrote none, `invalid` when it is too large or not a JUnit report. */
export function readReport(path: string): Result<TestCase[]> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return err("not_found", `no report was written to ${path}`);
  }
  if (size > MAX_REPORT_BYTES) return err("invalid", `the report is ${size} bytes, more than the ${MAX_REPORT_BYTES} bytes canon reads`);
  return parseJUnit(readFileSync(path, "utf8"));
}
