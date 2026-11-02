import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../repo/git.ts";
import { codeReview, type Env } from "./code-review.ts";

function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/**
 * A repository with one landing (base → head) that changes src/queue.ts and a canon doc, plus stand-ins:
 * the AI prints `answer.json` after saving its prompt; `gh` logs each call and answers from `open.json`
 * (the open-issue list) and `search.json` (title search).
 */
function setup(answer: unknown, open: unknown[] = [], search: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), "canon-code-review-"));
  const tools = mkdtempSync(join(tmpdir(), "canon-code-review-tools-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/queue.ts"), "export const a = 1;\nexport const untouched = 'context line';\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  const base = sh(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/queue.ts"), "export const a = 2;\nexport const untouched = 'context line';\n");
  mkdirSync(join(root, "canon/rules"), { recursive: true });
  writeFileSync(join(root, "canon/rules/x.md"), "doc\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "landing");
  const head = sh(root, "rev-parse", "HEAD");

  writeFileSync(join(tools, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(tools, "open.json"), JSON.stringify(open));
  writeFileSync(join(tools, "search.json"), JSON.stringify(search));
  writeFileSync(
    join(tools, "gh.ts"),
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(tools, "gh.log"))}, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") console.log(readFileSync(${JSON.stringify(tools)} + (args.includes("--search") ? "/search.json" : "/open.json"), "utf8"));
if (args[0] === "issue" && args[1] === "create") console.log("https://github.com/o/r/issues/77");
`,
  );
  const lines: string[] = [];
  const env: Env = {
    cwd: root,
    base,
    head,
    change: "C-5",
    ai: `sh -c 'cat > ${join(tools, "prompt.txt")}; cat ${join(tools, "answer.json")}'`,
    gh: `bun ${join(tools, "gh.ts")}`,
    say: (l) => lines.push(l),
  };
  const calls = () => {
    try {
      return readFileSync(join(tools, "gh.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { root, tools, env, lines, calls, prompt: () => readFileSync(join(tools, "prompt.txt"), "utf8") };
}

const finding = (over: Record<string, unknown> = {}) => ({
  kind: "concurrency",
  title: "Queue turn is not atomic",
  root_cause: "tryTurn reads and writes the queue in two statements",
  file: "src/queue.ts",
  line: 1,
  scenario: "two landers call tryTurn at the same moment → both land",
  existing: null,
  ...over,
});

describe("post-land code review", () => {
  test("BR-2070: the reviewer sees the whole landed diff and the full text of each changed code file, and is asked only about security and concurrency", () => {
    const t = setup({ findings: [] });
    expect(codeReview(t.env).ok).toBe(true);
    const p = t.prompt();
    expect(p).toContain("ONLY for security problems and concurrency problems");
    expect(p).toContain("-export const a = 1;");
    expect(p).toContain("## src/queue.ts");
    expect(p).toContain("export const untouched = 'context line';"); // full text, not only the diff hunk
    expect(p).not.toContain("## canon/rules/x.md"); // documents are not code
  });

  test("BR-2070: binary files are not given as full text, deleted files appear only in the diff", () => {
    const t = setup({ findings: [] });
    writeFileSync(join(t.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    sh(t.root, "rm", "-q", "src/queue.ts");
    mkdirSync(join(t.root, "src"), { recursive: true });
    writeFileSync(join(t.root, "src/new.ts"), "export const b = 1;\n");
    sh(t.root, "add", "-A");
    sh(t.root, "commit", "-qm", "binary and delete");
    const env = { ...t.env, base: t.env.head, head: sh(t.root, "rev-parse", "HEAD") };
    expect(codeReview(env).ok).toBe(true);
    const p = t.prompt();
    expect(p).toContain("## src/new.ts");
    expect(p).not.toContain("## logo.png");
    expect(p).not.toContain("## src/queue.ts");
    expect(p).toContain("-export const a = 2;"); // the deletion is in the diff
  });

  test("BR-2070: the script refuses to run without CANON_BASE and CANON_HEAD", () => {
    const script = join(import.meta.dir, "..", "..", "scripts", "code-review.ts");
    const env = { ...process.env } as Record<string, string>;
    delete env["CANON_BASE"];
    delete env["CANON_HEAD"];
    const r = Bun.spawnSync(["bun", script], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("CANON_BASE and CANON_HEAD are required");
  });

  test("BR-2070: a landing that changed no code does not call the reviewer", () => {
    const t = setup({ findings: [finding()] });
    const docsOnly = { ...t.env, base: sh(t.root, "rev-parse", "HEAD"), head: sh(t.root, "rev-parse", "HEAD") };
    expect(codeReview(docsOnly).ok).toBe(true);
    expect(t.lines).toContain("no code changed; nothing to review");
    expect(t.calls()).toEqual([]);
  });

  test("BR-2071: findings without a file, a line or a scenario are dropped, not filed", () => {
    const t = setup({ findings: [finding({ file: "" }), finding({ line: 0 }), finding({ scenario: " " }), finding({ kind: "style" })] });
    const r = codeReview(t.env);
    expect(r.ok && r.value).toEqual({ created: [], commented: [] });
    expect(t.lines.filter((l) => l.startsWith("dropped")).length).toBe(4);
    expect(t.calls().some((c) => c[1] === "create")).toBe(false);
  });

  test("BR-2072: a new root cause becomes one labelled issue; several findings with that root cause share it", () => {
    const t = setup({ findings: [finding(), finding({ line: 2, root_cause: "tryTurn  Reads and writes the queue in two statements", scenario: "a retry interleaves with a landing → lost update" })] });
    const r = codeReview(t.env);
    expect(r.ok && r.value).toEqual({ created: ["https://github.com/o/r/issues/77"], commented: [] });
    const creates = t.calls().filter((c) => c[1] === "create");
    expect(creates.length).toBe(1);
    expect(creates[0]).toContain("canon-review");
    const issueBody = creates[0]![creates[0]!.indexOf("--body") + 1]!;
    expect(issueBody).toContain("`src/queue.ts:1`");
    expect(issueBody).toContain("`src/queue.ts:2`");
  });

  test("BR-2072: an open issue with the same root cause gets a comment instead of a new issue, whether the AI names it or the title matches", () => {
    const open = [{ number: 12, title: "Queue turn is not atomic", body: "tryTurn ..." }];
    const named = setup({ findings: [finding({ existing: 12 })] }, open);
    expect(codeReview(named.env)).toMatchObject({ ok: true, value: { created: [], commented: [12] } });
    expect(named.prompt()).toContain("#12 Queue turn is not atomic");

    const byTitle = setup({ findings: [finding()] }, open, [{ number: 12, title: "queue turn is not atomic" }]);
    expect(codeReview(byTitle.env)).toMatchObject({ ok: true, value: { created: [], commented: [12] } });
    expect(byTitle.calls().filter((c) => c[1] === "comment").map((c) => c[2])).toEqual(["12"]);
    const search = byTitle.calls().find((c) => c.includes("--search"))!;
    expect(search.slice(search.indexOf("--label"), search.indexOf("--label") + 2)).toEqual(["--label", "canon-review"]); // only labelled issues match by title

    const closedNumber = setup({ findings: [finding({ existing: 99 })] }, open, []);
    expect(codeReview(closedNumber.env)).toMatchObject({ ok: true, value: { created: ["https://github.com/o/r/issues/77"], commented: [] } });
  });
});
