import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
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
    expect(t.lines).toContain("no findings");
    const p = t.prompt();
    expect(p).toContain("ONLY for security problems and concurrency problems");
    expect(p).toContain("-export const a = 1;");
    expect(p).toContain("## src/queue.ts");
    expect(p).toContain("export const untouched = 'context line';"); // full text, not only the diff hunk
    expect(p).not.toContain("## canon/rules/x.md"); // documents are not code
  });

  test("BR-2070: the reviewer is asked only for problems that normal operations lead to, whatever a test needs to force them, except data loss, security and broken promises", () => {
    const t = setup({ findings: [] });
    expect(codeReview(t.env).ok).toBe(true);
    const p = t.prompt();
    expect(p).toContain("Report only problems that normal operations lead to: the scenario must say who hits it in which normal operation.");
    expect(p).toContain("How a test could reproduce it does not decide: a race between two normal operations is real even when a test needs a barrier to force it.");
    expect(p).toContain("Do not report situations that need an abnormal setup or action");
    expect(p).toContain("unless the problem loses data, is a security problem, or breaks what the project promises");
    expect(p).toContain("P1 to P7 in canon/product.md");
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

  test("BR-2070: a landing that only deletes a code file, or only changes a binary or oversized one, is still reviewed from its diff", () => {
    const t = setup({ findings: [] });
    const land = (edit: () => void) => {
      const base = sh(t.root, "rev-parse", "HEAD");
      edit();
      sh(t.root, "add", "-A");
      sh(t.root, "commit", "-qm", "landing");
      const lines: string[] = [];
      expect(codeReview({ ...t.env, base, head: sh(t.root, "rev-parse", "HEAD"), say: (l) => lines.push(l) }).ok).toBe(true);
      expect(lines).not.toContain("no code changed; nothing to review");
      return t.prompt();
    };
    const deleted = land(() => sh(t.root, "rm", "-q", "src/queue.ts"));
    expect(deleted).toContain("-export const a = 2;");
    expect(deleted).not.toContain("## src/queue.ts");
    const binary = land(() => writeFileSync(join(t.root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01])));
    expect(binary).toContain("logo.png");
    expect(binary).not.toContain("## logo.png");
    const big = `export const big = "${"x".repeat(100_001)}";\n`;
    const oversized = land(() => writeFileSync(join(t.root, "big.ts"), big));
    expect(oversized).toContain("+export const big");
    expect(oversized).not.toContain("## big.ts"); // over 100 KB: only in the diff
  });

  test("BR-2070: a landing that changes only files under canon/ does not call the reviewer", () => {
    const t = setup({ findings: [finding()] });
    const base = sh(t.root, "rev-parse", "HEAD");
    writeFileSync(join(t.root, "canon/rules/x.md"), "doc changed\n");
    sh(t.root, "commit", "-qam", "docs only");
    expect(codeReview({ ...t.env, base, head: sh(t.root, "rev-parse", "HEAD") }).ok).toBe(true);
    expect(t.lines).toEqual(["no code changed; nothing to review"]);
    expect(t.calls()).toEqual([]);
    expect(existsSync(join(t.tools, "prompt.txt"))).toBe(false);
  });

  test("BR-2070: the script prints code-review: <reason> and exits 1 when the reviewer fails, with no 'no findings'", () => {
    const t = setup({ findings: [] });
    const script = join(import.meta.dir, "..", "..", "..", "scripts", "code-review.ts");
    const env = { ...process.env, CANON_CODE_REVIEW_FORCE: "1", CANON_BASE: t.env.base, CANON_HEAD: t.env.head, CANON_CODE_REVIEW_AI: "sh -c 'echo broken >&2; exit 1'", CANON_GH: t.env.gh } as Record<string, string>;
    const r = Bun.spawnSync(["bun", script], { cwd: t.root, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/^code-review: .*exited 1/m);
    expect(r.stdout.toString() + r.stderr.toString()).not.toContain("no findings");
  });

  test("BR-2070: the script refuses to run without CANON_BASE and CANON_HEAD", () => {
    const script = join(import.meta.dir, "..", "..", "..", "scripts", "code-review.ts");
    const env = { ...process.env } as Record<string, string>;
    delete env["CANON_BASE"];
    delete env["CANON_HEAD"];
    const r = Bun.spawnSync(["bun", script], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("CANON_BASE and CANON_HEAD are required");
  });

  test("BR-2070: a failing reviewer is an error, never no findings", () => {
    const t = setup({ findings: [] });
    const r = codeReview({ ...t.env, ai: "sh -c 'echo broken >&2; exit 1'" });
    expect(r.ok).toBe(false);
    expect(t.lines).not.toContain("no findings");
    const garbled = setup({ findings: [] });
    expect(codeReview({ ...garbled.env, ai: "echo not-json" }).ok).toBe(false);
    expect(garbled.lines).not.toContain("no findings");
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
    expect(t.lines).toContain("no findings");
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

  test("BR-2210: an issue and a comment carry the kind, the landing, the root cause, one line per finding and the reproduce command", () => {
    const t = setup({ findings: [finding()] });
    expect(codeReview(t.env).ok).toBe(true);
    const create = t.calls().find((c) => c[1] === "create")!;
    expect(create[create.indexOf("--title") + 1]).toBe("Queue turn is not atomic");
    const text = create[create.indexOf("--body") + 1]!.split("\n");
    expect(text[0]).toBe(`**concurrency**, found by the post-land code review of C-5 (\`${t.env.base.slice(0, 9)}..${t.env.head.slice(0, 9)}\`).`);
    expect(text).toContain("Root cause: tryTurn reads and writes the queue in two statements");
    expect(text).toContain("- `src/queue.ts:1` (in range): two landers call tryTurn at the same moment → both land");
    expect(text.at(-1)).toBe(`Reproduce from: \`git diff ${t.env.base.slice(0, 9)} ${t.env.head.slice(0, 9)} -- src/queue.ts\``);

    const anonymous = setup({ findings: [finding()] });
    expect(codeReview({ ...anonymous.env, change: "" }).ok).toBe(true);
    const body = anonymous.calls().find((c) => c[1] === "create")!;
    expect(body[body.indexOf("--body") + 1]).toContain("found by the post-land code review of a landing (");

    const open = [{ number: 12, title: "Queue turn is not atomic", body: "x" }];
    const two = setup({ findings: [finding({ existing: 12 }), finding({ existing: 12, line: 2, scenario: "a retry interleaves → lost update" })] }, open);
    expect(codeReview(two.env).ok).toBe(true);
    const comment = two.calls().find((c) => c[1] === "comment")!;
    const lines = comment[comment.indexOf("--body") + 1]!.split("\n");
    expect(lines[0]).toStartWith("**concurrency**, found by the post-land code review of C-5");
    expect(lines.filter((l) => l.startsWith("- `src/queue.ts:"))).toEqual(["- `src/queue.ts:1` (in range): two landers call tryTurn at the same moment → both land", "- `src/queue.ts:2` (in range): a retry interleaves → lost update"]);
  });

  test("BR-2211: gh failing to list, create or comment is an error with exit 1, never no findings", () => {
    const listing = setup({ findings: [finding()] });
    const failing = `sh -c 'echo nope >&2; exit 1'`;
    const r = codeReview({ ...listing.env, gh: failing });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain("issue list --state open --label canon-review");
    expect(!r.ok && r.error.message).toContain("exited 1");
    expect(existsSync(join(listing.tools, "prompt.txt"))).toBe(false); // the reviewer was not called
    expect(listing.lines).not.toContain("no findings");

    const creating = setup({ findings: [finding()] });
    const gh = join(creating.tools, "gh-no-create.sh");
    writeFileSync(gh, `if [ "$2" = "create" ]; then echo denied >&2; exit 1; fi\necho '[]'\n`);
    const script = join(import.meta.dir, "..", "..", "..", "scripts", "code-review.ts");
    const env = { ...process.env, CANON_CODE_REVIEW_FORCE: "1", CANON_BASE: creating.env.base, CANON_HEAD: creating.env.head, CANON_CODE_REVIEW_AI: creating.env.ai, CANON_GH: `sh ${gh}` } as Record<string, string>;
    const run = Bun.spawnSync(["bun", script], { cwd: creating.root, env, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toMatch(/^code-review: [^\n]*issue create[\s\S]*exited 1: denied/);
    expect(run.stdout.toString()).not.toContain("no findings");

    const fine = setup({ findings: [] });
    const ok = Bun.spawnSync(["bun", script], { cwd: fine.root, env: { ...env, CANON_CODE_REVIEW_FORCE: "1", CANON_BASE: fine.env.base, CANON_HEAD: fine.env.head, CANON_CODE_REVIEW_AI: fine.env.ai, CANON_GH: fine.env.gh }, stdout: "pipe", stderr: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("code-review: no findings");
  });

  test("BR-2211: a failing title search is an error with exit 1 that files nothing, unless the AI named an open issue", () => {
    const failing = setup({ findings: [finding()] });
    const gh = join(failing.tools, "gh-no-search.sh");
    writeFileSync(gh, `echo "$*" >> ${JSON.stringify(join(failing.tools, "calls.log"))}\ncase "$*" in *--search*) echo "search down" >&2; exit 1;; esac\necho '[]'\n`);
    const script = join(import.meta.dir, "..", "..", "..", "scripts", "code-review.ts");
    const env = { ...process.env, CANON_CODE_REVIEW_FORCE: "1", CANON_BASE: failing.env.base, CANON_HEAD: failing.env.head, CANON_CODE_REVIEW_AI: failing.env.ai, CANON_GH: `sh ${gh}` } as Record<string, string>;
    const run = Bun.spawnSync(["bun", script], { cwd: failing.root, env, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toMatch(/^code-review: [^\n]*issue list [^\n]*--search[\s\S]*exited 1: search down/);
    expect(run.stdout.toString()).not.toContain("no findings");
    const calls = readFileSync(join(failing.tools, "calls.log"), "utf8");
    expect(calls).not.toContain("issue create");
    expect(calls).not.toContain("issue comment");

    // The AI named an open labelled issue: no search runs, so a broken search changes nothing.
    const named = setup({ findings: [finding({ existing: 12 })] }, [{ number: 12, title: "Queue turn is not atomic", body: "" }]);
    const r = codeReview(named.env);
    expect(r.ok).toBe(true);
    expect(named.calls().some((c) => c.includes("--search"))).toBe(false);
    expect(named.calls().some((c) => c[1] === "comment" && c[2] === "12")).toBe(true);
  });
});
