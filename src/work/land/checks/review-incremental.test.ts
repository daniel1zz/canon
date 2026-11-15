import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, reviewLandings, sh, startNew, ws } from "../../testkit.ts";

const [one, two] = [["BR", 1].join("-"), ["BR", 2].join("-")];
const ruleText = (id: string, text: string) => `---\nid: ${id}\ntitle: Refunds ${id}\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

/**
 * billing with a reviewer that answers `verdicts` in turn (the last repeats) and keeps each prompt. A change lands a rule,
 * another landing on main changes it, and the change lands the same text again (BR-2396's case).
 */
function relanding(verdicts: string[] = ["ok"]) {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-runs.log`;
  const script = `${base}-reviewer.sh`;
  const answers = verdicts.map((v, i) => `[ "$n" = ${i + 1} ] && echo '{"verdict":"${v}","findings":["${one} note ${i + 1}"]}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\nn=$(( $( (cat ${log} 2>/dev/null || true) | wc -l) + 1 ))\ncat > ${base}-prompt-$n\necho run >> ${log}\n${answers}\n[ "$n" -gt ${verdicts.length} ] && echo '{"verdict":"${verdicts[verdicts.length - 1]}","findings":["${one} note last"]}'\ntrue\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
  const prompt = (n: number) => readFileSync(`${base}-prompt-${n}`, "utf8");
  const events = (kind: string) => ws(root).db.db.query<{ id: number; detail: string }, [string]>("SELECT id, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r): Record<string, unknown> & { id: number } => ({ ...(JSON.parse(r.detail) as Record<string, unknown>), id: r.id }));
  /** Commits on main directly, as another change's landing would; `text` undefined deletes the file. */
  const onMain = (path: string, text: string | undefined) => {
    if (text === undefined) sh(root, "rm", "-q", path);
    else writeFileSync(join(root, path), text);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", `main: ${path}`);
  };
  const start = (text = "Refunds are fine.") => {
    const s = startNew(root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${one}.md`), ruleText(one, text));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    return s;
  };
  /** Brings the change's worktree up to main and writes `one` with `text` in a new commit. */
  const rewrite = (wt: string, text: string) => {
    sh(wt, "rebase", "-q", "main");
    writeFileSync(join(wt, `canon/rules/billing/${one}.md`), ruleText(one, text));
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "rule again");
  };
  /** Lands `wt` and runs the review after it; what the review said. */
  const landReviewed = async (wt: string) => {
    expect((await land(ws(wt), FAST, quiet)).kind).toBe("landed");
    return (await reviewLandings(root)).join("\n");
  };
  return { root, runs, prompt, events, onMain, start, rewrite, landReviewed };
}

describe("reviewing a landing whose changed documents already passed (D-81)", () => {
  test("BR-2490 BR-2396 BR-2009 BR-2036 BR-2359: a rule that landed on main since the pass is reviewed with the unchanged rule in a small review, whose index holds only those two, and which records incremental", async () => {
    const t = relanding();
    const old = ["BR", 3].join("-");
    t.onMain(`canon/rules/billing/${old}.md`, ruleText(old, "Old refunds stay. ".repeat(6000)));
    const s = t.start();
    await t.landReviewed(s.worktree);
    const full = t.events("review.ok")[0]!;
    expect(full["docs_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(full["base"]).toMatch(/^[0-9a-f]{40}$/);
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are slow."));
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    t.onMain("canon/config.yaml", readFileSync(join(t.root, "canon/config.yaml"), "utf8") + "review_max_total_prompt_kb: 64\n");
    t.rewrite(s.worktree, "Refunds are fine.");
    const said = await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(2);
    expect(Buffer.byteLength(t.prompt(1))).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(t.prompt(2))).toBeLessThan(64 * 1024);
    expect(t.events("review.budget.ask")).toEqual([]);
    expect(t.prompt(2)).toContain("# Incremental review");
    expect(t.prompt(2)).toContain("Refunds are logged.");
    for (const n of [1, 2]) {
      const prompt = t.prompt(n);
      const at = prompt.indexOf("# Current context for");
      expect(at).toBeGreaterThan(0);
      expect(prompt.slice(0, at)).toContain("## 规则\n\nRefunds are fine.");
      expect(prompt.slice(at)).not.toContain("Refunds are fine.");
    }
    expect(t.prompt(1)).not.toContain("# Incremental review");
    expect(t.prompt(1)).toContain(`Refunds ${old}`); // the full review sees the whole domain and the index
    expect(t.prompt(2)).not.toContain(`Refunds ${old}`); // the small one only the changed and the newly landed documents
    expect(said).toContain(`reviewing them only against what landed on main since: ${two}`);
    expect(said).toContain(`${one} note 1`); // the full review's note is still handed on
    const small = t.events("review.ok")[1]!;
    expect(small).toMatchObject({ docs_hash: full["docs_hash"], incremental: { from: full.id, added: [two] } });
    expect(small["hash"]).toBeUndefined();
  }, 60_000);

  test("BR-2490 BR-2396: when no other rule or decision landed on main since, the pass is reused by its documents and the review command does not run", async () => {
    const t = relanding();
    const s = t.start();
    await t.landReviewed(s.worktree);
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are slow.")); // the changed document itself does not count
    // a domain README is not a rule or a decision: the full prompt changes, the documents that landed do not
    t.onMain("canon/rules/billing/README.md", "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回给客户\n\n## 业务\n\n- **x**：y\n");
    t.onMain("canon/config.yaml", readFileSync(join(t.root, "canon/config.yaml"), "utf8") + "review_max_total_prompt_kb: 0.001\n");
    t.rewrite(s.worktree, "Refunds are fine.");
    const said = await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(1);
    expect(t.events("review.budget.ask")).toEqual([]);
    expect(said).toContain("no rule or decision landed on main since; the review command was not run");
    expect(t.events("review.reused")).toMatchObject([{ review: "land", by: "docs", from: t.events("review.ok")[0]!.id }]);
  }, 60_000);

  test("BR-2405 BR-2396: the small review lists the lines an edited rule adds, without the shared-wording hints; a new rule has no such entry", async () => {
    const t = relanding();
    const old = ["BR", 3].join("-");
    const copied = "A refund above the monthly limit is held for review by the finance team and released only after a second person approves it in writing.";
    t.onMain(`canon/rules/billing/${old}.md`, ruleText(old, copied));
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are fine."));
    const restating = `Refunds are fine.\n\n${copied.slice(0, -1)}, as ${old} says.`;
    const s = startNew(t.root, "Edit rule");
    t.rewrite(s.worktree, restating);
    await t.landReviewed(s.worktree);
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are fine."));
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    t.rewrite(s.worktree, restating);
    await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(2);
    expect(t.prompt(1)).toContain("# Possible restatements found by shared wording"); // the full review gets the hints
    const small = t.prompt(2);
    expect(small).toContain("# Incremental review");
    const section = "\n# Lines added or changed in this landing\n"; // the section heading, not the criterion's mention of it
    expect(small).toContain(section);
    expect(small).toContain(`## ${one} (canon/rules/billing/${one}.md)\n\n11: ${copied.slice(0, -1)}, as ${old} says.\n`); // only the added line
    expect(small).not.toContain("# Possible restatements found by shared wording");
    // the other side: a rule new in this landing has no entry, so all of its lines are new
    const n = relanding();
    const ns = n.start();
    await n.landReviewed(ns.worktree);
    n.onMain(`canon/rules/billing/${one}.md`, undefined);
    n.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    n.rewrite(ns.worktree, "Refunds are fine.");
    await n.landReviewed(ns.worktree);
    expect(n.prompt(2)).toContain("# Incremental review");
    expect(n.prompt(2)).not.toContain(section);
  }, 90_000);

  test("BR-2493 BR-2396: when only the change's 方案依据 is new, the pass of the same documents is not reused and the review sees the basis", async () => {
    const t = relanding();
    const s = t.start();
    await t.landReviewed(s.worktree);
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are slow.")); // as in the reuse case above: the same text lands again
    t.rewrite(s.worktree, "Refunds are fine.");
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}`))!);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n## 方案依据\n\n沿用：无。新选择：SENTINEL-basis-c41。\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "basis");
    await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(2);
    expect(t.prompt(2)).toContain("SENTINEL-basis-c41");
    expect(t.events("review.reused")).toEqual([]);
  }, 60_000);

  test("BR-2496 BR-2396: the same active text landing again after main made it planned with will_amend is not answered by the older pass; the review compares the declared target", async () => {
    const t = relanding();
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    const s = t.start();
    await t.landReviewed(s.worktree);
    const planned = ruleText(one, "Refunds are fine.").replace("untested: demo\n", `untested: demo\nstatus: planned\nwill_amend: [${two}]\n`);
    t.onMain(`canon/rules/billing/${one}.md`, planned);
    t.rewrite(s.worktree, "Refunds are fine.");
    // only a change that lists a planned rule in rules: may make it active (BR-2240)
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(s.change))!);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^rules: \[\]$/m, `rules: [${one}]`));
    sh(s.worktree, "commit", "-qam", "lists the rule it activates");
    await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toEqual([]);
    expect(t.prompt(2)).toContain(`# ${one} becomes active in this landing; while planned it declared it would change ${two}`);
  }, 60_000);

  test("BR-2396 BR-2361: a changed rule text, or a pass that was later blocked, is reviewed in full", async () => {
    const t = relanding(["ok", "block", "ok"]);
    const s = t.start();
    await t.landReviewed(s.worktree);
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are slow."));
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    t.rewrite(s.worktree, "Refunds are fine!");
    await t.landReviewed(s.worktree);
    expect(t.events("review.block")).toHaveLength(1); // the full review of the changed text blocked
    expect(t.prompt(2)).not.toContain("# Incremental review");
    t.onMain(`canon/rules/billing/${one}.md`, ruleText(one, "Refunds are slow again."));
    t.rewrite(s.worktree, "Refunds are fine!");
    await t.landReviewed(s.worktree);
    expect(t.runs()).toBe(3);
    expect(t.prompt(3)).not.toContain("# Incremental review");
  }, 60_000);
});
