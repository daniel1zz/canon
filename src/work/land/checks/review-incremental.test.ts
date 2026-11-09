import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

const [one, two] = [["BR", 1].join("-"), ["BR", 2].join("-")];
const ruleText = (id: string, text: string) => `---\nid: ${id}\ntitle: Refunds ${id}\nuntested: demo\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

/**
 * billing with a reviewer that answers `verdicts` in turn (the last repeats) and keeps each prompt, and a before_land
 * hook that fails the first landing, so the change lands again with the same rule text.
 */
function relanding(verdicts: string[] = ["ok"]) {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-runs.log`;
  const script = `${base}-reviewer.sh`;
  const marker = `${base}-hook-ran`;
  const answers = verdicts.map((v, i) => `[ "$n" = ${i + 1} ] && echo '{"verdict":"${v}","findings":["${one} note ${i + 1}"]}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\nn=$(( $( (cat ${log} 2>/dev/null || true) | wc -l) + 1 ))\ncat > ${base}-prompt-$n\necho run >> ${log}\n${answers}\n[ "$n" -gt ${verdicts.length} ] && echo '{"verdict":"${verdicts[verdicts.length - 1]}","findings":["${one} note last"]}'\ntrue\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\nhooks:\n  before_land: 'test -f ${marker} || { touch ${marker}; exit 1; }'\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
  const prompt = (n: number) => readFileSync(`${base}-prompt-${n}`, "utf8");
  const events = (kind: string) => ws(root).db.db.query<{ id: number; detail: string }, [string]>("SELECT id, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r): Record<string, unknown> & { id: number } => ({ ...(JSON.parse(r.detail) as Record<string, unknown>), id: r.id }));
  const onMain = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
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
  return { root, runs, prompt, events, onMain, start };
}

describe("reviewing a re-landing whose changed documents already passed (D-81)", () => {
  test("BR-2396: a rule that landed on main since the pass is reviewed with the unchanged rule in a small review, which records incremental", async () => {
    const t = relanding();
    const s = t.start();
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("refused");
    const full = t.events("review.ok")[0]!;
    expect(full["docs_hash"]).toMatch(/^[0-9a-f]{64}$/);
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    expect(t.runs()).toBe(2);
    expect(t.prompt(2)).toContain("# Incremental review");
    expect(t.prompt(2)).toContain("Refunds are logged.");
    expect(t.prompt(1)).not.toContain("# Incremental review");
    expect(said.join("\n")).toContain(`reviewing them only against what landed on main since: ${two}`);
    expect(said.join("\n")).toContain(`${one} note 1`); // the full review's note is still handed on
    const small = t.events("review.ok")[1]!;
    expect(small).toMatchObject({ docs_hash: full["docs_hash"], incremental: { from: full.id, added: [two] } });
    expect(small["hash"]).toBeUndefined();
  }, 60_000);

  test("BR-2396: when nothing landed on main since but the prompt changed, the pass is reused by its documents and the review command does not run", async () => {
    const t = relanding();
    const s = t.start();
    await land(ws(s.worktree), FAST, quiet);
    // a domain README is not a rule or a decision: the full prompt changes, the documents that landed do not
    t.onMain("canon/rules/billing/README.md", "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回给客户\n");
    const said: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => said.push(l))).kind).toBe("landed");
    expect(t.runs()).toBe(1);
    expect(said.join("\n")).toContain("no rule or decision landed on main since; the review command was not run");
    expect(t.events("review.reused")).toMatchObject([{ review: "land", by: "docs", from: t.events("review.ok")[0]!.id }]);
  }, 60_000);

  test("BR-2396 BR-2361: a changed rule text, or a pass that was later blocked, is reviewed in full", async () => {
    const t = relanding(["ok", "block", "ok"]);
    const s = t.start();
    await land(ws(s.worktree), FAST, quiet);
    writeFileSync(join(s.worktree, `canon/rules/billing/${one}.md`), ruleText(one, "Refunds are fine!"));
    sh(s.worktree, "commit", "-qam", "edit");
    t.onMain(`canon/rules/billing/${two}.md`, ruleText(two, "Refunds are logged."));
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("refused"); // blocked by the full review
    expect(t.prompt(2)).not.toContain("# Incremental review");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(t.prompt(3)).not.toContain("# Incremental review");
  }, 60_000);
});
