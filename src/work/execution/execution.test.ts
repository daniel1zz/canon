import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { land } from "../land/land.ts";
import { previewReview } from "../../knowledge/review/preview.ts";
import { judgeLandedWording } from "../../knowledge/review/landed-wording.ts";
import { reviewTree } from "../land/checks/review-tree.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { openFindings } from "../../knowledge/review/findings/findings.ts";
import { behaviourHash } from "../../knowledge/documents/behaviour.ts";
import type { Change } from "../../knowledge/documents/model.ts";
import { FAST, project, quiet, reviewLandings, sh, startNew, ws } from "../testkit.ts";
import { recordReport } from "../verify/ledger.ts";
import { commentOnly, newSideHunks } from "./evidence.ts";
import type { TestCase } from "../verify/report.ts";

// reason: each test lands one or more changes through real worktrees, which takes seconds under load
const TIMED = 60_000;

// Fixture ids are assembled at runtime, so this file's own text names no rule.
const br = (n: number) => ["BR", n].join("-");
const FINISH = { ...FAST, finish: true };

const ruleText = (n: number, o: { status?: string; untested?: string; statement?: string; examples?: string; title?: string } = {}) =>
  `---\nid: ${br(n)}\ntitle: ${o.title ?? `Rule ${n}`}\n${o.status ? `status: ${o.status}\n` : ""}${o.untested ? `untested: ${o.untested}\n` : ""}business: x\n---\n## 规则\n\n${o.statement ?? `Statement ${n}.`}\n\n## 例子\n\n${o.examples ?? `- input ${n} → output ${n}`}\n`;

const testFile = (ns: number[], extra = "") => `${ns.map((n) => `it("${br(n)}: case", () => {\n  expect(${n}).toBe(${n});\n});\n`).join("")}${extra}`;

/**
 * What a framework's report would say about a fixture test file (BR-2338): a testcase per `it("name", …)` call, with the
 * line it starts on, and per `it.skip("name", …)` one that does not run. Recorded the way `canon work test` records (BR-2337).
 */
function report(db: ReturnType<typeof ws>["db"], root: string, path: string, text: string, withLines = true): void {
  const cases: TestCase[] = [];
  text.split("\n").forEach((line, i) => {
    const m = /^it(\.skip)?\("([^"]+)"/.exec(line);
    if (m) cases.push({ suites: [], classname: "", name: m[2]!, runs: m[1] === undefined, ...(withLines ? { line: i + 1 } : {}) });
  });
  recordReport(db, path, sh(root, "hash-object", path), cases, "test_command");
}

/**
 * billing with rules BR-1, BR-2 (tested in src/billing/a.test.ts) and whatever `rules` adds; `review` is the review
 * command, or none. Every file in `files` is committed on main.
 */
function fixture(o: { files?: Record<string, string>; review?: string; timing?: string } = {}): string {
  const root = project();
  const files: Record<string, string> = {
    "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\n${o.timing ? `floor_timing: ${o.timing}\n` : ""}review: ${JSON.stringify(o.review ?? "none")}\n`,
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n",
    [`canon/rules/billing/${br(1)}.md`]: ruleText(1),
    [`canon/rules/billing/${br(2)}.md`]: ruleText(2),
    "src/billing/a.test.ts": testFile([1, 2]),
    ...o.files,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  for (const [p, text] of Object.entries(files)) if (p.endsWith(".test.ts")) report(ws(root).db, root, p, text);
  return root;
}

const changePath = (wt: string, change: string) => join(wt, "canon/changes", readdirSync(join(wt, "canon/changes")).find((f) => f === `${change}.md` || f.startsWith(`${change}-`))!);

/** Sets the change's `rules:` and, when given, appends a `## 验收` section. */
function setChange(wt: string, change: string, rules: string[], acceptance?: string, extraMeta = "") {
  const path = changePath(wt, change);
  let text = readFileSync(path, "utf8").replace(/^rules:.*\n((?:  - .*\n)*)/m, `rules: [${rules.join(", ")}]\n${extraMeta}`);
  if (acceptance !== undefined) text = `${text.trimEnd()}\n\n## 验收\n\n${acceptance}\n`;
  writeFileSync(path, text);
}

function write(wt: string, files: Record<string, string>, message = "work") {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), text);
  }
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", message);
  for (const [p, text] of Object.entries(files)) if (p.endsWith(".test.ts")) report(ws(wt).db, wt, p, text);
}

/** The change as the checkout at `root` holds it (main's checkout after a landing, or the change's worktree). */
const changeOn = (root: string, _where: "main" | "HEAD", change: string): Change => {
  const corpus = readCorpus(root).corpus;
  return corpus.docs.find((d): d is Change => d.kind === "change" && d.id === change)!;
};

const hashOf = (root: string, n: number) => behaviourHash(readCorpus(root).corpus.docs.find((d) => d.id === br(n))!.body);

/** A say that keeps the lines, to read what the landing said. */
function collect(): { lines: string[]; say: (line: string) => void } {
  const lines: string[] = [];
  return { lines, say: (line: string) => lines.push(line) };
}

/**
 * BR-2241: `id` landed without evidence: the change is done on main with no record for it, the landing said so, and an
 * execution.unverified event names it for canon work due.
 */
function landedUnverified(root: string, change: string, id: string, out: { kind: string }, lines: readonly string[]) {
  expect(out.kind).toBe("landed");
  expect(changeOn(root, "main", change).status).toBe("done");
  expect(changeOn(root, "main", change).passes[id]).toBeUndefined();
  expect(lines.join("\n")).toContain(`evidence: ${id}: no evidence of this execution; it lands as 待重新执行`);
  const ev = ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'execution.unverified' AND subject = ? ORDER BY id DESC LIMIT 1").get(change);
  expect(JSON.parse(ev!.detail).rules).toContain(id);
}

/** Lands a first change that migrates, so main holds pass records and later changes write only their own. */
async function migrated(root: string): Promise<void> {
  const s = startNew(root, "Migrate");
  const out = await land(ws(s.worktree), FINISH, quiet);
  if (out.kind !== "landed") throw new Error(`migration landing: ${JSON.stringify(out)}`);
}

describe("evidence at --finish (BR-2241)", () => {
  test("BR-2241 BR-2242: a change that changed a line in the test naming its rule closes with a test record of the rule's hash", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Execute one");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // output 10") });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(1)]: { hash: hashOf(root, 1), method: "test", wording: false } });
  }, TIMED);

  test("BR-2241: touching only another rule's test is no evidence: the change lands without a record for the rule, says so and records execution.unverified (D-141)", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Wrong test");
    // the examples change, so this is not a wording-only edit (BR-2243): it needs evidence
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(2)", "toBe(2); // other") });
    const c = collect();
    const out = await land(ws(s.worktree), FINISH, c.say);
    landedUnverified(root, s.change, br(1), out, c.lines);
    expect(c.lines.join("\n")).toContain("canon work due lists them");
  }, TIMED);

  test("BR-2241: a changed line in a skipped test is no evidence", async () => {
    const root = fixture({ files: { "src/billing/b.test.ts": `it.skip("${br(1)}: later", () => {\n  expect(1).toBe(1);\n});\n` } });
    await migrated(root);
    const s = startNew(root, "Skipped");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/b.test.ts": `it.skip("${br(1)}: later", () => {\n  expect(10).toBe(10);\n});\n` });
    const c = collect();
    landedUnverified(root, s.change, br(1), await land(ws(s.worktree), FINISH, c.say), c.lines);
  }, TIMED);

  test("BR-2241: a test changed in an earlier landing of the same change counts at the --finish landing that changes only documents", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Two landings");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // output 10") });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10", title: "Renamed" }) }, "title only");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ method: "test" });
  }, TIMED);

  test("BR-2241: an untested rule with an acceptance line closes with an acceptance record; a line without → and result is no evidence, so it lands with none", async () => {
    const accept = async (line: string) => {
      const root = fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider" }) } });
      await migrated(root);
      const s = startNew(root, "Accept");
      setChange(s.worktree, s.change, [br(3)], `- ${br(3)}：${line}`);
      write(s.worktree, { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider", examples: "- refund → shown" }) });
      const c = collect();
      return { root, s, c, out: await land(ws(s.worktree), FINISH, c.say) };
    };
    const bare = await accept("在沙箱下单退款");
    landedUnverified(bare.root, bare.s.change, br(3), bare.out, bare.c.lines);
    expect(bare.c.lines.join("\n")).toContain("## 验收");
    const full = await accept("在沙箱下单退款 → 服务商后台显示已退");
    expect(full.out.kind).toBe("landed");
    expect(changeOn(full.root, "main", full.s.change).passes).toEqual({ [br(3)]: { hash: hashOf(full.root, 3), method: "acceptance", wording: false } });
  }, TIMED * 2);

  test("BR-2241: a listed rule whose hash already has another change's record, or that is planned or retired, needs no evidence and gets no record", async () => {
    const root = fixture({ files: { [`canon/rules/billing/${br(4)}.md`]: ruleText(4, { status: "planned" }), [`canon/rules/billing/${br(5)}.md`]: ruleText(5, { untested: "x" }) } });
    await migrated(root); // BR-1 and BR-2 now have migration records
    const s = startNew(root, "Title only");
    setChange(s.worktree, s.change, [br(1), br(4), br(5)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { title: "New title" }), [`canon/rules/billing/${br(5)}.md`]: ruleText(5, { untested: "x", status: "retired" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({});
    expect(readFileSync(changePath(root, s.change), "utf8")).not.toContain("passes:");
  }, TIMED);

  test("BR-2241: a line deleted inside the running test that names the rule is evidence", async () => {
    const root = fixture({ files: { "src/billing/a.test.ts": `it("${br(1)}: case", () => {\n  expect(1).toBe(1);\n  expect(0).toBe(0);\n});\n${testFile([2])}` } });
    await migrated(root);
    const s = startNew(root, "Delete a line");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": `it("${br(1)}: case", () => {\n  expect(1).toBe(1);\n});\n${testFile([2])}` });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ method: "test" });
  }, TIMED);
});

describe("evidence from the report's lines (BR-2241, D-64)", () => {
  const run = async (o: { lines: boolean; edit: (text: string) => string; record?: boolean }) => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Execute by report");
    setChange(s.worktree, s.change, [br(1)]);
    const file = "src/billing/a.test.ts";
    const text = o.edit(testFile([1, 2]));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), [file]: text });
    // `write` records the report with lines; a framework without line numbers or a missing report is recorded over it
    if (!o.lines || o.record === false) {
      const db = ws(s.worktree).db;
      db.db.query("DELETE FROM test_reports WHERE path = ? AND blob = ?").run(file, sh(s.worktree, "hash-object", file));
      if (o.record !== false) report(db, s.worktree, file, text, false);
    }
    const c = collect();
    return { root, s, lines: c.lines, out: await land(ws(s.worktree), FINISH, c.say) };
  };

  test("BR-2241: without line numbers in the report, a change anywhere in the file that has a running test naming the rule is evidence of method test-file", async () => {
    const { root, s, out } = await run({ lines: false, edit: (t) => t.replace("toBe(2)", "toBe(2); // other") });
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ method: "test-file" });
  }, TIMED);

  test("BR-2241: lines added inside the rule's test that are only comments or blank are evidence of method test-comment; one code line beside them makes it test (#250)", async () => {
    const only = await run({ lines: true, edit: (t) => t.replace("  expect(1).toBe(1);", "  // why the example went\n\n  expect(1).toBe(1);") });
    expect(only.out.kind).toBe("landed");
    expect(changeOn(only.root, "main", only.s.change).passes[br(1)]).toMatchObject({ method: "test-comment" });
    const mixed = await run({ lines: true, edit: (t) => t.replace("  expect(1).toBe(1);", "  // why the example went\n  expect(1).toBe(1);\n  expect(10).toBe(10);") });
    expect(mixed.out.kind).toBe("landed");
    expect(changeOn(mixed.root, "main", mixed.s.change).passes[br(1)]).toMatchObject({ method: "test" });
  }, TIMED * 2);

  test("BR-2241: a comment line is known by the test file's extension; an extension not listed counts only blank lines, and a block comment counts as code (#250)", () => {
    expect(commentOnly("game/tests/a_test.gd", ["\t# note", ""])).toBe(true);
    expect(commentOnly("tests/test_a.py", ["# note"])).toBe(true);
    expect(commentOnly("src/a.test.ts", ["  // note"])).toBe(true);
    expect(commentOnly("db/a_test.sql", ["-- note"])).toBe(true);
    expect(commentOnly("src/a.test.ts", ["  // note", "  expect(1).toBe(1);"])).toBe(false);
    expect(commentOnly("src/a.test.ts", ["  /* note */"])).toBe(false);
    expect(commentOnly("tests/a.unknown", ["# note"])).toBe(false);
    expect(commentOnly("tests/a.unknown", ["   "])).toBe(true);
    // a hunk that only deletes is judged by the lines it removes
    const hunks = newSideHunks("+++ b/src/a.test.ts\n@@ -3 +2,0 @@\n-  // old note\n+++ b/src/b.test.ts\n@@ -3,0 +4 @@\n+  expect(2).toBe(2);\n");
    expect(hunks.get("src/a.test.ts")).toEqual([{ from: 2, count: 0, text: ["  // old note"] }]);
    expect(hunks.get("src/b.test.ts")).toEqual([{ from: 4, count: 1, text: ["  expect(2).toBe(2);"] }]);
  });

  test("BR-2241: with line numbers the same edit to another rule's test is not evidence", async () => {
    const { root, s, out, lines } = await run({ lines: true, edit: (t) => t.replace("toBe(2)", "toBe(2); // other") });
    landedUnverified(root, s.change, br(1), out, lines);
  }, TIMED);

  test("BR-2241: a line before the first testcase belongs to no test, so it is no evidence", async () => {
    const { root, s, out, lines } = await run({ lines: true, edit: (t) => `// header\n${t}`.replace("// header\nit(", "// header changed\nit(") });
    landedUnverified(root, s.change, br(1), out, lines);
  }, TIMED);

  test("BR-2241 BR-2344: a changed test file with no report for its content gives no evidence; with no test_command to run it, canon check refuses the landing for the missing report", async () => {
    const { s, out } = await run({ lines: true, record: false, edit: (t) => t.replace("toBe(1)", "toBe(1); // output 10") });
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && JSON.stringify(out.findings)).toContain("test-report-missing");
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "invocation", "main.ts"), "check"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("test-report-missing");
  }, TIMED);
});

describe("rules a change edits without listing them (BR-2241, issue #104)", () => {
  test("BR-2241: an example edit to a rule left out of rules: is executed like a listed one: without evidence it lands with no record; with its test changed it gets one", async () => {
    const edit = async (withTest: boolean) => {
      const root = fixture();
      await migrated(root);
      const s = startNew(root, "Unlisted edit");
      setChange(s.worktree, s.change, []);
      write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), ...(withTest ? { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // output 10") } : {}) });
      const c = collect();
      return { root, s, c, out: await land(ws(s.worktree), FINISH, c.say) };
    };
    const bare = await edit(false);
    landedUnverified(bare.root, bare.s.change, br(1), bare.out, bare.c.lines);
    const tested = await edit(true);
    expect(tested.out.kind).toBe("landed");
    expect(changeOn(tested.root, "main", tested.s.change).passes).toEqual({ [br(1)]: { hash: hashOf(tested.root, 1), method: "test", wording: false } });
  }, TIMED * 2);

  test("BR-2241 BR-2243: a statement-only edit to a rule left out of rules: goes to the review as a wording judgement", async () => {
    const root = fixture();
    const prompt = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["src/**/*.test.ts"]\nreview: ${JSON.stringify(`cat > ${prompt}; echo '{"verdict":"ok","findings":[],"wording":{"${br(2)}":"wording"}}'`)}\n`);
    sh(root, "commit", "-qam", "review");
    await migrated(root);
    const s = startNew(root, "Unlisted reword");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(2)}.md`]: ruleText(2, { statement: "Statement two, reworded." }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(2)]: { hash: hashOf(root, 2), method: "migration", wording: true } });
    const said = (await reviewLandings(root)).join("\n"); // the wording judgement runs in the review after the landing (BR-2239)
    expect(said).toContain(`wording judgement: ${br(2)}: wording`);
    const ev = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'review.wording' ORDER BY id DESC LIMIT 1").get()!;
    expect(JSON.parse(ev.detail).docs).toEqual([br(2)]);
    expect(readFileSync(prompt, "utf8")).toContain("Statement two, reworded."); // the rule review after it read the new text
  }, TIMED);

  test("BR-2241: a rule only moved, a title-only edit, and a rule retired, none listed, need no evidence and get no record", async () => {
    const root = fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3), "src/billing/c.test.ts": testFile([3]) } });
    await migrated(root);
    const s = startNew(root, "Move only");
    setChange(s.worktree, s.change, []);
    // reason: the subdomain is not what this case is about; on main it is not a domain the change adds (BR-2446)
    mkdirSync(join(root, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "subdomain");
    mkdirSync(join(s.worktree, "canon/rules/billing/refunds"), { recursive: true });
    renameSync(join(s.worktree, `canon/rules/billing/${br(1)}.md`), join(s.worktree, `canon/rules/billing/refunds/${br(1)}.md`));
    sh(s.worktree, "rm", "-q", "src/billing/c.test.ts");
    write(s.worktree, { [`canon/rules/billing/${br(2)}.md`]: ruleText(2, { title: "Retitled" }), [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { status: "retired", examples: "- gone → yes" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({});
  }, TIMED);

  test("BR-2241: a new active rule left out of rules: is executed: with no evidence it lands as 待重新执行", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "New rule");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(6)}.md`]: ruleText(6, { untested: "provider" }) });
    const c = collect();
    landedUnverified(root, s.change, br(6), await land(ws(s.worktree), FINISH, c.say), c.lines);
  }, TIMED);
});

describe("the close commit's records (BR-2242)", () => {
  test("BR-2242: records written by hand before the close are replaced", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Hand written");
    setChange(s.worktree, s.change, [br(1)], undefined, `passes:\n  ${br(2)}: "0000000000000000 test"\n`);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // output 10") });
    expect((await land(ws(s.worktree), FINISH, quiet)).kind).toBe("landed");
    expect(Object.keys(changeOn(root, "main", s.change).passes)).toEqual([br(1)]);
  }, TIMED);

  test("BR-2242: a landing that edits a done change's records is refused with reason passes, naming it", async () => {
    const root = fixture();
    await migrated(root);
    const first = readCorpus(root).corpus.docs.find((d): d is Change => d.kind === "change" && d.status === "done")!;
    const s = startNew(root, "Edit records");
    const path = join(s.worktree, first.path);
    writeFileSync(path, readFileSync(path, "utf8").replace(/(BR-2: "?)[0-9a-f]{16}/, "$10000000000000000"));
    sh(s.worktree, "commit", "-qam", "tamper");
    const main = sh(root, "rev-parse", "main");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("passes");
    expect(out.kind === "refused" && out.message).toContain(first.id);
    expect(sh(root, "rev-parse", "main")).toBe(main);
  }, TIMED);
});

describe("planned rules made active (BR-2240)", () => {
  const planned = () => fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { status: "planned" }) } });
  const activate = () => ({ [`canon/rules/billing/${br(3)}.md`]: ruleText(3), "src/billing/c.test.ts": testFile([3]) });

  test("BR-2240: a change that lists the planned rule may make it active", async () => {
    const root = planned();
    const s = startNew(root, "Activate listed");
    setChange(s.worktree, s.change, [br(3)]);
    write(s.worktree, activate());
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
  }, TIMED);

  test("BR-2240: a change that does not list it is refused with reason activate, naming the rule; main does not move", async () => {
    const root = planned();
    const s = startNew(root, "Activate unlisted");
    write(s.worktree, activate());
    const main = sh(root, "rev-parse", "main");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("activate");
    expect(out.kind === "refused" && out.message).toContain(br(3));
    expect(sh(root, "rev-parse", "main")).toBe(main);
  }, TIMED);

  test("BR-2240: a rule new as active, or a planned rule that stays planned, is not refused", async () => {
    const root = planned();
    const s = startNew(root, "No activation");
    write(s.worktree, { [`canon/rules/billing/${br(4)}.md`]: ruleText(4), "src/billing/d.test.ts": testFile([4]), [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { status: "planned", examples: "- other → thing" }) });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
  }, TIMED);
});

describe("wording-only edits (BR-2243, BR-2239)", () => {
  const promptOf = (root: string) => join(root, "..", `${root.split("/").pop()}-prompt.txt`);
  const reviewing = (root: string, answer: string) => `cat > ${promptOf(root)}; echo '${answer}'`;
  /** A review command that counts its calls in `<root>-asked` and keeps each prompt in `<prompt>-<n>`; `answer` gives the reply to call n. */
  const counting = (root: string, first: string, rest: string = first) =>
    `n=$(cat ${root}-asked 2>/dev/null || echo 0); echo $((n + 1)) > ${root}-asked; cat > ${promptOf(root)}-$n; if [ "$n" = 0 ]; then echo '${first}'; else echo '${rest}'; fi`;
  const asked = (root: string) => (existsSync(`${root}-asked`) ? Number(readFileSync(`${root}-asked`, "utf8").trim()) : 0);
  const reworded = { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) };
  const lastEvent = (root: string, kind: string) => {
    const row = ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind);
    return row ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined;
  };
  const wordingFindings = (root: string) => openFindings(ws(root).db).filter((f) => f.criterion === "wording");

  async function wordingProject(answer: (root: string) => string | undefined) {
    const root = fixture();
    const review = answer(root);
    if (review !== undefined) {
      writeFileSync(join(root, "canon/config.yaml"), `floor: "touch ${root}-floor-ran"\ntests: ["src/**/*.test.ts"]\nreview: ${JSON.stringify(review)}\n`);
      sh(root, "commit", "-q", "--allow-empty", "-am", "review"); // the fixture may already hold this value
    }
    await migrated(root);
    const s = startNew(root, "Reword");
    setChange(s.worktree, s.change, [br(1)]);
    return { root, s };
  }

  /** Lands the change with --finish, then runs the reviews queued after it (BR-2441): the landing's outcome and lines, what the reviews said. */
  async function landThenReview(root: string, wt: string) {
    const c = collect();
    const out = await land(ws(wt), FINISH, c.say);
    const said = await reviewLandings(root);
    return { out, landing: c.lines.join("\n"), review: said.join("\n") };
  }

  test("BR-2358 BR-2239: canon work review asks the wording judgement of a statement-only edit and reports wording; the change stays open", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, reworded);
    const out = await previewReview(ws(s.worktree), undefined);
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.wording).toEqual([{ id: br(1), answer: "wording" }]);
    expect(readFileSync(promptOf(root), "utf8")).toContain("# Wording judgements");
    expect(changeOn(s.worktree, "HEAD", s.change).status).toBe("open");
  }, TIMED);

  test("BR-2358 BR-2239: canon work review reports a behaviour answer as an open finding the review after landing would record, with exit 0; an edit with new evidence asks nothing", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"Statement one, changed.","requires":"a changed statement"}}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, changed." }) });
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "review"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toContain(`wording judgement: ${br(1)}: behaviour: “Statement one, changed.” requires a changed statement; the review after landing would record it as an open finding on ${br(1)}: change a line in a running test whose title names ${br(1)}`);
    write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // changed") });
    const after = await previewReview(ws(s.worktree), undefined);
    expect(after.kind === "ok" && after.wording).toEqual([]);
    expect(readFileSync(promptOf(root), "utf8")).not.toContain("# Wording judgements");
  }, TIMED);

  test("BR-2358 BR-2239: with review: none, canon work review says the wording-only record has no one to judge it and would land unjudged; exit 0", async () => {
    const { s } = await wordingProject(() => "none");
    write(s.worktree, reworded);
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), "work", "review"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toContain(`wording judgement: ${br(1)}: no review command to judge it; it would land as a wording-only edit nobody judged`);
  }, TIMED);

  test("BR-2243 BR-2239: only the statement changed: the landing records the method with wording and calls no model; the review after it asks the wording judgement first, apart from the rule review", async () => {
    const { root, s } = await wordingProject((r) => counting(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, reworded);
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(asked(root)).toBe(0); // the landing itself calls no model (D-141)
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(1)]: { hash: hashOf(root, 1), method: "migration", wording: true } });
    const said = (await reviewLandings(root)).join("\n");
    const prompt = readFileSync(`${promptOf(root)}-0`, "utf8");
    expect(prompt).toContain("# Wording judgements");
    expect(prompt).toContain("Statement 1.");
    expect(prompt).toContain("Statement one, reworded.");
    expect(prompt).not.toContain("# Domain: billing"); // the wording judgement is its own call; the rule review is the next one
    expect(said).toContain(`wording judgement: ${br(1)}: wording; its earlier pass carries over`);
    expect(lastEvent(root, "review.wording")?.["wording"]).toEqual({ [br(1)]: "wording" });
    expect(wordingFindings(root)).toEqual([]);
  }, TIMED);

  test("BR-2239 BR-2014 BR-2022: the review answering behaviour, or giving no wording field, does not refuse: the change lands, the floor runs, and the review after it opens a wording finding on the rule naming the change", async () => {
    for (const answer of [`{"verdict":"ok","findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"Statement one, reworded.","requires":"a changed statement"}}}`, `{"verdict":"ok","findings":[]}`]) {
      const { root, s } = await wordingProject((r) => reviewing(r, answer));
      write(s.worktree, reworded);
      rmSync(`${root}-floor-ran`, { force: true }); // the fixture's own landings ran the floor
      const r = await landThenReview(root, s.worktree);
      expect(r.out.kind).toBe("landed");
      expect(existsSync(`${root}-floor-ran`)).toBe(true);
      expect(changeOn(root, "main", s.change).status).toBe("done");
      const found = wordingFindings(root);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ids: [br(1)], change: s.change });
      expect(found[0]!.text).toContain(answer.includes("quote") ? `the review answered behaviour: “Statement one, reworded.” requires a changed statement` : "the review answered nothing");
      expect(r.review).toContain("not confirmed as wording-only edits");
    }
  }, TIMED * 2);

  test("BR-2239, BR-2216: an answer canon cannot read is asked once more with the error; a readable second answer is the judgement, a second unreadable one fails the review after landing saying it asked twice (#227)", async () => {
    const good = await wordingProject((r) => counting(r, `{"findings":["${br(1)} changes when the line shows"]}`, `{"findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(good.s.worktree, reworded);
    const g = await landThenReview(good.root, good.s.worktree);
    expect(g.out.kind).toBe("landed");
    expect(g.review).toContain("wording judgement: the answer could not be read");
    expect(g.review).toContain(`wording judgement: ${br(1)}: wording`);
    const again = readFileSync(`${promptOf(good.root)}-1`, "utf8");
    expect(again.startsWith(readFileSync(`${promptOf(good.root)}-0`, "utf8"))).toBe(true);
    expect(again).toContain("# Your previous answer could not be read");
    expect(again).toContain("no findings with a criterion");
    const bad = await wordingProject((r) => counting(r, `{"findings":["${br(1)} changes when the line shows"]}`, `{"findings":[{"criterion":"note"}]}`));
    write(bad.s.worktree, reworded);
    const b = await landThenReview(bad.root, bad.s.worktree);
    expect(b.out.kind).toBe("landed");
    expect(asked(bad.root)).toBe(2); // the rule review is not run once the judgement failed
    expect(String(lastEvent(bad.root, "review.fail")?.["message"])).toContain("asked twice; neither answer could be read");
    expect(changeOn(bad.root, "main", bad.s.change).status).toBe("done");
  }, TIMED * 2);

  test("BR-2239: two unreadable answers that carry text fail the review after landing with the reviewer's words in full and a review.unparsed event; no finding is opened (#252)", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"findings":["${br(1)} changes when the line shows"]}`));
    write(s.worktree, reworded);
    const r = await landThenReview(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    const message = String(lastEvent(root, "review.fail")?.["message"]);
    expect(message).toContain(`what the reviewer wrote:\n  - ${br(1)} changes when the line shows`);
    expect(message).not.toContain("asked twice; neither answer could be read");
    expect(lastEvent(root, "review.unparsed")?.["texts"]).toEqual([`${br(1)} changes when the line shows`]);
    expect(openFindings(ws(root).db)).toEqual([]);
  }, TIMED);

  test("BR-2239: a review command that fails is not asked again (#227); the landing is not affected", async () => {
    const { root, s } = await wordingProject((r) => `n=$(cat ${r}-asked 2>/dev/null || echo 0); echo $((n + 1)) > ${r}-asked; cat > /dev/null; echo boom >&2; exit 3`);
    write(s.worktree, reworded);
    const r = await landThenReview(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(String(lastEvent(root, "review.fail")?.["message"])).not.toContain("asked twice");
    expect(asked(root)).toBe(1);
  }, TIMED);

  test("BR-2239: a behaviour answer without a quote found in the rule's 规则 now counts as wording, and the review says so (#256)", async () => {
    for (const answer of [
      `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"behaviour"}}`, // the old bare string: no quote
      `{"verdict":"ok","findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"Statement one, never written.","requires":"a changed statement"}}}`, // a quote that is not in the rule
      `{"verdict":"ok","findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"","requires":"a changed statement"}}}`, // an empty quote
    ]) {
      const { root, s } = await wordingProject((r) => reviewing(r, answer));
      write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement   one,\n reworded." }) });
      const r = await landThenReview(root, s.worktree);
      expect(r.out.kind).toBe("landed");
      expect(r.review).toContain(`wording judgement: ${br(1)}: behaviour without a quote from the rule: treated as wording`);
      expect(lastEvent(root, "review.wording")).toMatchObject({ wording: { [br(1)]: "wording" }, unquoted: [br(1)] });
      expect(wordingFindings(root)).toEqual([]);
    }
    // the quote is compared with whitespace squashed, so a quote across the rule's line break still stands
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"Statement one, reworded.","requires":"a changed statement"}}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement   one,\n reworded." }) });
    await landThenReview(root, s.worktree);
    expect(wordingFindings(root)).toHaveLength(1);
  }, TIMED * 4);

  test("BR-2296 BR-2239: a wording judgement that runs past review_timeout_minutes is stopped and fails the review after landing; the landing is not affected", async () => {
    const { root, s } = await wordingProject((r) => `cat > /dev/null; echo $$ > ${r}-pid; exec sleep 30`);
    writeFileSync(join(root, "canon/config.yaml"), readFileSync(join(root, "canon/config.yaml"), "utf8") + "review_timeout_minutes: 0.05\n");
    sh(root, "commit", "-qam", "3 s review limit");
    write(s.worktree, reworded);
    const r = await landThenReview(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(String(lastEvent(root, "review.fail")?.["message"])).toContain("did not finish within");
    expect(changeOn(root, "main", s.change).status).toBe("done");
  }, TIMED);

  test("BR-2366 BR-2239: the wording judgement after landing runs with CANON_REVIEW_KIND=land", async () => {
    const { root, s } = await wordingProject((r) => `printenv CANON_REVIEW_KIND >> ${r}-kind; cat > /dev/null; echo '{"findings":[],"wording":{"${br(1)}":"wording"}}'`);
    write(s.worktree, reworded);
    await landThenReview(root, s.worktree);
    expect(readFileSync(`${root}-kind`, "utf8").trim().split("\n")[0]).toBe("land");
  }, TIMED);

  test("BR-2490 BR-2239: the wording judgement after landing is outside the review budget: a budget of one call still lets the rule review run beside it", async () => {
    const { root, s } = await wordingProject((r) => counting(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    writeFileSync(join(root, "canon/config.yaml"), readFileSync(join(root, "canon/config.yaml"), "utf8") + "review_max_calls: 1\n");
    sh(root, "commit", "-qam", "one review call");
    write(s.worktree, reworded);
    const r = await landThenReview(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(asked(root)).toBe(2); // the wording judgement, then the one rule review call the budget allows
    expect(lastEvent(root, "review.fail")).toBeUndefined();
  }, TIMED);

  test("BR-2361 BR-2239: a judgement that confirmed every rule is reused for the same prompt and command; one that answered behaviour is asked again", async () => {
    const q = [{ id: br(1), title: "Rule 1", before: "Statement 1.", after: "Statement one, reworded.", examples: "- input 1 → output 1" }];
    const cases: [string, number][] = [
      [`{"findings":[],"wording":{"${br(1)}":"wording"}}`, 1],
      [`{"findings":[],"wording":{"${br(1)}":{"verdict":"behaviour","quote":"Statement one, reworded.","requires":"a changed statement"}}}`, 2],
    ];
    for (const [answer, runs] of cases) {
      const root = fixture();
      const command = counting(root, answer);
      const main = sh(root, "rev-parse", "main");
      const tree = reviewTree(ws(root), {}, main);
      for (let i = 0; i < 2; i++) {
        const r = await judgeLandedWording(ws(root), { change: "C-1", head: main, reviewerAt: main, at: "before" }, quiet, command, { timeoutMs: 60_000, kind: "land" }, tree, q);
        expect(r.ok).toBe(true);
      }
      expect(tree.release().ok).toBe(true);
      expect(asked(root)).toBe(runs);
    }
  }, TIMED);

  test("BR-2239 BR-2074: with no review command, review unset or review: none, the wording record lands unjudged and the landing says so", async () => {
    // "" is unset (BR-2074); "none" is the explicit opt-out, which still leaves nobody to judge the wording
    for (const review of ["", "none"]) {
      const { root, s } = await wordingProject(() => review);
      write(s.worktree, reworded);
      const c = collect();
      const out = await land(ws(s.worktree), FINISH, c.say);
      expect(out.kind).toBe("landed");
      expect(c.lines.join("\n")).toContain(`the wording-only records of ${br(1)} were not judged`);
      expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ wording: true });
    }
  }, TIMED * 2);

  test("BR-2239 BR-2010 BR-2441: the review after landing asks the wording judgement even when this landing changes no rule file", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, reworded);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    await reviewLandings(root); // the rule review of the reworded rule
    writeFileSync(promptOf(root), "");
    const r = await landThenReview(root, s.worktree);
    expect(r.out.kind).toBe("landed");
    expect(readFileSync(promptOf(root), "utf8")).toContain(`## ${br(1)} Rule 1`);
    expect(readFileSync(promptOf(root), "utf8")).toContain("# Wording judgements");
  }, TIMED);

  test("BR-2243: a changed example gives no wording path: without a test the rule lands with no record", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded.", examples: "- input 1 → output 11" }) });
    const c = collect();
    landedUnverified(root, s.change, br(1), await land(ws(s.worktree), FINISH, c.say), c.lines);
  }, TIMED);

  test("BR-2243: a rule moved to a subdomain with only its statement changed still finds its earlier version", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    // reason: the subdomain is not what this case is about; on main it is not a domain the change adds (BR-2446)
    mkdirSync(join(root, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "subdomain");
    mkdirSync(join(s.worktree, "canon/rules/billing/refunds"), { recursive: true });
    renameSync(join(s.worktree, `canon/rules/billing/${br(1)}.md`), join(s.worktree, `canon/rules/billing/refunds/${br(1)}.md`));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "move");
    write(s.worktree, { [`canon/rules/billing/refunds/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ wording: true, method: "migration" });
  }, TIMED);
});

describe("a rule changed by someone else while landing (BR-2244)", () => {
  test("BR-2244: an example edit to the executed rule in a file the change did not touch refuses with reason rule-changed", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Execute");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // checked") });
    const o = startNew(root, "Other");
    write(o.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 12" }), "src/billing/e.test.ts": testFile([1]) });
    setChange(o.worktree, o.change, []);
    expect((await land(ws(o.worktree), FAST, quiet)).kind).toBe("landed");
    const main = sh(root, "rev-parse", "main");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("rule-changed");
    expect(out.kind === "refused" && out.message).toContain(br(1));
    expect(out.kind === "refused" && out.message).toContain("git rebase main");
    expect(sh(root, "rev-parse", "main")).toBe(main);
    expect(changeOn(s.worktree, "HEAD", s.change).status).toBe("open");
  }, TIMED);

  test("BR-2244: a title-only edit or an edit to another rule lands", async () => {
    for (const other of [{ [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { title: "Retitled" }) }, { [`canon/rules/billing/${br(2)}.md`]: ruleText(2, { title: "Other" }) }]) {
      const root = fixture();
      await migrated(root);
      const s = startNew(root, "Execute");
      setChange(s.worktree, s.change, [br(1)]);
      write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // checked") });
      const o = startNew(root, "Other");
      write(o.worktree, other);
      expect((await land(ws(o.worktree), FAST, quiet)).kind).toBe("landed");
      // the executed rule has a migration record of its current hash, so this change records it only through its test
      const out = await land(ws(s.worktree), FINISH, quiet);
      expect(out.kind).toBe("landed");
    }
  }, TIMED * 2);

  test("BR-2244: the executed rule retired on main meanwhile refuses with reason rule-changed", async () => {
    const root = fixture({ files: { "src/billing/a.test.ts": testFile([2]), "src/billing/g.test.ts": testFile([1]) } });
    await migrated(root);
    const s = startNew(root, "Execute");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { "src/billing/g.test.ts": testFile([1]).replace("toBe(1)", "toBe(1); // checked") });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed"); // the test evidence lands first
    const o = startNew(root, "Retire");
    sh(o.worktree, "rm", "-q", "src/billing/g.test.ts");
    write(o.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { status: "retired" }) });
    expect((await land(ws(o.worktree), FAST, quiet)).kind).toBe("landed");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("rule-changed");
    expect(out.kind === "refused" && out.message).toContain(br(1));
  }, TIMED);
});

describe("migration (BR-2245)", () => {
  test("BR-2245: the first close writes migration records for tested active rules, none for an untested-only or planned rule; a listed rule gets its own method", async () => {
    const root = fixture({
      files: {
        [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider" }),
        [`canon/rules/billing/${br(4)}.md`]: ruleText(4, { status: "planned" }),
        "src/billing/b.test.ts": testFile([4]),
      },
    });
    const s = startNew(root, "First");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // checked") });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({
      [br(1)]: { hash: hashOf(root, 1), method: "test", wording: false },
      [br(2)]: { hash: hashOf(root, 2), method: "migration", wording: false },
    });
  }, TIMED);

  test("BR-2245: a rule only a skipped testcase of the report names gets no migration record, one a running testcase names does", async () => {
    const root = fixture({
      files: {
        [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider" }),
        "src/billing/b.test.ts": `it.skip("${br(3)}: later", () => {});\n`,
      },
    });
    const s = startNew(root, "First, with a skipped test");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // checked") });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(Object.keys(changeOn(root, "main", s.change).passes)).toEqual([br(1), br(2)]); // BR-3 is named only by a skipped test
  }, TIMED);

  test("BR-2245: once main holds records, a later close writes no migration record", async () => {
    const root = fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3), "src/billing/b.test.ts": testFile([3]) } });
    const first = startNew(root, "First");
    setChange(first.worktree, first.change, [br(1)]);
    write(first.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // checked") });
    // reason: the first close migrates BR-2 and BR-3; rule 3 then changes, so a second migration would show
    expect((await land(ws(first.worktree), FINISH, quiet)).kind).toBe("landed");
    const s = startNew(root, "Second");
    write(s.worktree, { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { examples: "- changed → yes" }), "src/billing/b.test.ts": testFile([3]).replace("toBe(3)", "toBe(3); // changed") });
    expect((await land(ws(s.worktree), FINISH, quiet)).kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(3)]: { hash: hashOf(root, 3), method: "test", wording: false } });
  }, TIMED);

  test("BR-2245: in the first close, a tested rule the change edits without listing it is executed, not migrated: with no evidence it gets no record at all", async () => {
    const root = fixture();
    const s = startNew(root, "First, unlisted edit");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }) });
    const c = collect();
    landedUnverified(root, s.change, br(1), await land(ws(s.worktree), FINISH, c.say), c.lines);
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(2)]: { hash: hashOf(root, 2), method: "migration", wording: false } });
  }, TIMED);

  test("BR-2245: a hand-written migration record in a landing after main holds records is refused with reason passes", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Fake migration");
    write(s.worktree, { [`canon/rules/billing/${br(2)}.md`]: ruleText(2, { examples: "- changed → yes" }) });
    // reason: the record is written into the change file after canon's own close would replace it, i.e. on a done change
    const path = changePath(s.worktree, s.change);
    writeFileSync(path, readFileSync(path, "utf8").replace("status: open", "status: done").replace(/^rules:.*$/m, `rules: []\npasses:\n  ${br(2)}: "${hashOf(s.worktree, 2)} migration"`));
    sh(s.worktree, "commit", "-qam", "fake");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("passes");
  }, TIMED);
});
