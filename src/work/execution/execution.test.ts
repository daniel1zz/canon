import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { land } from "../land/land.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { behaviourHash } from "../../knowledge/documents/behaviour.ts";
import type { Change } from "../../knowledge/documents/model.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";
import { recordReport } from "../verify/ledger.ts";
import type { TestCase } from "../verify/report.ts";

// reason: each test lands one or more changes through real worktrees, which takes seconds under load
const TIMED = 60_000;

// Fixture ids are assembled at runtime, so this file's own text names no rule.
const br = (n: number) => ["BR", n].join("-");
const FINISH = { ...FAST, finish: true };

const ruleText = (n: number, o: { status?: string; untested?: string; statement?: string; examples?: string; title?: string } = {}) =>
  `---\nid: ${br(n)}\ntitle: ${o.title ?? `Rule ${n}`}\n${o.status ? `status: ${o.status}\n` : ""}${o.untested ? `untested: ${o.untested}\n` : ""}---\n## 规则\n\n${o.statement ?? `Statement ${n}.`}\n\n## 例子\n\n${o.examples ?? `- input ${n} → output ${n}`}\n`;

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
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
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

  test("BR-2241: touching only another rule's test refuses with reason evidence, before any close commit", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Wrong test");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(2)", "toBe(2); // other") });
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const main = sh(root, "rev-parse", "main");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("evidence");
    expect(out.kind === "refused" && out.message).toContain(br(1));
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head); // no close commit
    expect(sh(root, "rev-parse", "main")).toBe(main);
    expect(changeOn(s.worktree, "HEAD", s.change).status).toBe("open");
  }, TIMED);

  test("BR-2241: a changed line in a skipped test is no evidence", async () => {
    const root = fixture({ files: { "src/billing/b.test.ts": `it.skip("${br(1)}: later", () => {\n  expect(1).toBe(1);\n});\n` } });
    await migrated(root);
    const s = startNew(root, "Skipped");
    setChange(s.worktree, s.change, [br(1)]);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }), "src/billing/b.test.ts": `it.skip("${br(1)}: later", () => {\n  expect(10).toBe(10);\n});\n` });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("evidence");
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

  test("BR-2241: an untested rule with an acceptance line closes with an acceptance record; a line without → and result is refused", async () => {
    const root = fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider" }) } });
    await migrated(root);
    const s = startNew(root, "Accept");
    setChange(s.worktree, s.change, [br(3)], `- ${br(3)}：在沙箱下单退款`);
    write(s.worktree, { [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { untested: "provider", examples: "- refund → shown" }) });
    const refused = await land(ws(s.worktree), FINISH, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("evidence");
    expect(refused.kind === "refused" && refused.message).toContain("## 验收");
    const path = changePath(s.worktree, s.change);
    writeFileSync(path, readFileSync(path, "utf8").replace("在沙箱下单退款", "在沙箱下单退款 → 服务商后台显示已退"));
    sh(s.worktree, "commit", "-qam", "acceptance");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(3)]: { hash: hashOf(root, 3), method: "acceptance", wording: false } });
  }, TIMED);

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
    return { root, s, out: await land(ws(s.worktree), FINISH, quiet) };
  };

  test("BR-2241: without line numbers in the report, a change anywhere in the file that has a running test naming the rule is evidence of method test-file", async () => {
    const { root, s, out } = await run({ lines: false, edit: (t) => t.replace("toBe(2)", "toBe(2); // other") });
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes[br(1)]).toMatchObject({ method: "test-file" });
  }, TIMED);

  test("BR-2241: with line numbers the same edit to another rule's test is not evidence", async () => {
    const { out } = await run({ lines: true, edit: (t) => t.replace("toBe(2)", "toBe(2); // other") });
    expect(out.kind === "refused" && out.reason).toBe("evidence");
  }, TIMED);

  test("BR-2241: a line before the first testcase belongs to no test, so it is no evidence", async () => {
    const { out } = await run({ lines: true, edit: (t) => `// header\n${t}`.replace("// header\nit(", "// header changed\nit(") });
    expect(out.kind === "refused" && out.reason).toBe("evidence");
  }, TIMED);

  test("BR-2241: a changed test file with no report for its content gives no evidence, and canon check names the missing report", async () => {
    const { s, out } = await run({ lines: true, record: false, edit: (t) => t.replace("toBe(1)", "toBe(1); // output 10") });
    expect(out.kind === "refused" && out.reason).toBe("evidence");
    expect(out.kind === "refused" && out.message).toContain("canon work test has recorded a report for its current content");
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "invocation", "main.ts"), "check"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("test-report-missing");
  }, TIMED);
});

describe("rules a change edits without listing them (BR-2241, issue #104)", () => {
  test("BR-2241: an example edit to a rule left out of rules: needs evidence like a listed one; with its test changed it gets a record", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "Unlisted edit");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }) });
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const refused = await land(ws(s.worktree), FINISH, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("evidence");
    expect(refused.kind === "refused" && refused.message).toContain(br(1));
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    write(s.worktree, { "src/billing/a.test.ts": testFile([1, 2]).replace("toBe(1)", "toBe(1); // output 10") });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(1)]: { hash: hashOf(root, 1), method: "test", wording: false } });
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
    expect(readFileSync(prompt, "utf8")).toContain("# Wording judgements");
  }, TIMED);

  test("BR-2241: a rule only moved, a title-only edit, and a rule retired, none listed, need no evidence and get no record", async () => {
    const root = fixture({ files: { [`canon/rules/billing/${br(3)}.md`]: ruleText(3), "src/billing/c.test.ts": testFile([3]) } });
    await migrated(root);
    const s = startNew(root, "Move only");
    setChange(s.worktree, s.change, []);
    mkdirSync(join(s.worktree, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(s.worktree, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n");
    renameSync(join(s.worktree, `canon/rules/billing/${br(1)}.md`), join(s.worktree, `canon/rules/billing/refunds/${br(1)}.md`));
    sh(s.worktree, "rm", "-q", "src/billing/c.test.ts");
    write(s.worktree, { [`canon/rules/billing/${br(2)}.md`]: ruleText(2, { title: "Retitled" }), [`canon/rules/billing/${br(3)}.md`]: ruleText(3, { status: "retired", examples: "- gone → yes" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({});
  }, TIMED);

  test("BR-2241: a new active rule left out of rules: needs evidence", async () => {
    const root = fixture();
    await migrated(root);
    const s = startNew(root, "New rule");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(6)}.md`]: ruleText(6, { untested: "provider" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("evidence");
    expect(out.kind === "refused" && out.message).toContain(br(6));
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

  async function wordingProject(answer: (root: string) => string | undefined) {
    const root = fixture();
    const review = answer(root);
    if (review !== undefined) {
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["src/**/*.test.ts"]\nreview: ${JSON.stringify(review)}\n`);
      sh(root, "commit", "-q", "--allow-empty", "-am", "review"); // the fixture may already hold this value
    }
    await migrated(root);
    const s = startNew(root, "Reword");
    setChange(s.worktree, s.change, [br(1)]);
    return { root, s };
  }

  test("BR-2243 BR-2239: only the statement changed and the review answers wording: the record copies the method with wording; the prompt had the judgement", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(changeOn(root, "main", s.change).passes).toEqual({ [br(1)]: { hash: hashOf(root, 1), method: "migration", wording: true } });
    const prompt = readFileSync(promptOf(root), "utf8");
    expect(prompt).toContain("# Wording judgements");
    expect(prompt).toContain("Statement 1.");
    expect(prompt).toContain("Statement one, reworded.");
    const ev = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'review.ok' ORDER BY id DESC LIMIT 1").get()!;
    expect(JSON.parse(ev.detail).wording).toEqual({ [br(1)]: "wording" });
  }, TIMED);

  test("BR-2239: the review answering behaviour, or giving no wording field, refuses with reason review naming the rule; the change stays open", async () => {
    for (const answer of [`{"verdict":"ok","findings":[],"wording":{"${br(1)}":"behaviour"}}`, `{"verdict":"ok","findings":[]}`]) {
      const { root, s } = await wordingProject((r) => reviewing(r, answer));
      write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
      const out = await land(ws(s.worktree), FINISH, quiet);
      expect(out.kind === "refused" && out.reason).toBe("review");
      expect(out.kind === "refused" && out.message).toContain(br(1));
      expect(changeOn(s.worktree, "HEAD", s.change).status).toBe("open");
    }
  }, TIMED * 2);

  test("BR-2361 BR-2239: a review that answered behaviour is not reused for the same prompt: the review command runs again", async () => {
    const { root, s } = await wordingProject((r) => `echo run >> ${promptOf(r)}.runs; cat > /dev/null; echo '{"verdict":"ok","findings":[],"wording":{"${br(1)}":"behaviour"}}'`);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
    for (let i = 0; i < 2; i++) {
      const out = await land(ws(s.worktree), FINISH, quiet);
      expect(out.kind === "refused" && out.reason).toBe("review");
    }
    expect(readFileSync(`${promptOf(root)}.runs`, "utf8").trim().split("\n")).toHaveLength(2);
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.reused'").get()?.n).toBe(0);
  }, TIMED);

  test("BR-2239 BR-2074: with no review command, review unset or review: none, the wording record is refused with reason review", async () => {
    // "" is unset (BR-2074); "none" is the explicit opt-out, which still leaves nobody to judge the wording
    for (const review of ["", "none"]) {
      const { s } = await wordingProject(() => review);
      write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
      const out = await land(ws(s.worktree), FINISH, quiet);
      expect(out.kind === "refused" && out.reason).toBe("review");
      expect(out.kind === "refused" && out.message).toContain("no review command");
    }
  }, TIMED * 2);

  test("BR-2239 BR-2010: the review runs for the wording record even when this landing changes no rule file", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded." }) });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(promptOf(root), "");
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind).toBe("landed");
    expect(readFileSync(promptOf(root), "utf8")).toContain(`## ${br(1)} Rule 1`);
  }, TIMED);

  test("BR-2243: a changed example gives no wording path: without a test the landing is refused with reason evidence", async () => {
    const { s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { statement: "Statement one, reworded.", examples: "- input 1 → output 11" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("evidence");
  }, TIMED);

  test("BR-2243: a rule moved to a subdomain with only its statement changed still finds its earlier version", async () => {
    const { root, s } = await wordingProject((r) => reviewing(r, `{"verdict":"ok","findings":[],"wording":{"${br(1)}":"wording"}}`));
    mkdirSync(join(s.worktree, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(s.worktree, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n");
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

  test("BR-2245: in the first close, a tested rule the change edits without listing it is executed, not migrated", async () => {
    const root = fixture();
    const s = startNew(root, "First, unlisted edit");
    setChange(s.worktree, s.change, []);
    write(s.worktree, { [`canon/rules/billing/${br(1)}.md`]: ruleText(1, { examples: "- input 1 → output 10" }) });
    const out = await land(ws(s.worktree), FINISH, quiet);
    expect(out.kind === "refused" && out.reason).toBe("evidence");
    expect(out.kind === "refused" && out.message).toContain(br(1));
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
