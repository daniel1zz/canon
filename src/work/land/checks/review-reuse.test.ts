import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { previewReview } from "../../../knowledge/review/preview.ts";
import { FAST, project, quiet, reviewLandings, sh, startNew, ws } from "../../testkit.ts";
import { reviewKey } from "./review-reuse.ts";

const id = ["BR", 1].join("-");
const ruleText = (text: string) => `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

/** Queues the latest review after landing again, as when its reviewer died after recording the verdict and before marking it done (BR-2441). */
const requeue = (root: string) => ws(root).db.db.query("UPDATE landed_reviews SET state = 'queued' WHERE id = (SELECT MAX(id) FROM landed_reviews)").run();

/** billing with a counting reviewer: `verdicts` are its answers in turn, the last repeats. */
function reusing(verdicts: string[] = ["ok"]) {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-runs.log`;
  const script = `${base}-reviewer.sh`;
  const answers = verdicts.map((v, i) => `[ "$n" = ${i + 1} ] && echo '{"verdict":"${v}","findings":["${id} note ${i + 1}"]}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho run >> ${log}\nn=$(wc -l < ${log} | tr -d ' ')\n${answers}\n[ "$n" -gt ${verdicts.length} ] && echo '{"verdict":"${verdicts[verdicts.length - 1]}","findings":["${id} note last"]}'\ntrue\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
  const events = (like: string) => ws(root).db.db.query<{ id: number; kind: string; detail: string }, [string]>("SELECT id, kind, detail FROM events WHERE kind LIKE ? ORDER BY id").all(like);
  const rule = (wt: string, text: string) => {
    writeFileSync(join(wt, `canon/rules/billing/${id}.md`), ruleText(text));
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "rule", "--allow-empty");
  };
  /** Starts a change that writes the rule with `text`, lands it and runs the review after it; what the review said. */
  const landRule = async (text: string) => {
    const s = startNew(root, "Rule");
    rule(s.worktree, text);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    return { s, said: (await reviewLandings(root)).join("\n") };
  };
  return { root, runs, events, rule, landRule };
}

describe("reusing a passed rule review (BR-2361)", () => {
  test("BR-2361: a review after landing that passed, run again with the same prompts, does not call the review command and records review.reused with the hash", async () => {
    const t = reusing();
    await t.landRule("Refunds are fine.");
    expect(t.runs()).toBe(1);
    const ok = t.events("review.ok");
    const hash = JSON.parse(ok[0]!.detail).hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    requeue(t.root);
    const said = (await reviewLandings(t.root)).join("\n");
    expect(t.runs()).toBe(1);
    expect(said).toContain(`reused the passing review of the same prompts (event ${ok[0]!.id}, hash ${hash.slice(0, 12)}); the review command was not run`);
    expect(said).toContain(`${id} note 1`); // the note of the first review is still handed on
    const reused = t.events("review.reused");
    expect(reused).toHaveLength(1);
    expect(JSON.parse(reused[0]!.detail)).toMatchObject({ review: "land", hash, docs: [id], from: ok[0]!.id });
  }, 60_000);

  test("BR-2361: another landing whose prompt differs by one word runs the review command again and records no review.reused", async () => {
    const t = reusing();
    await t.landRule("Refunds are fine.");
    await t.landRule("Refunds are fine!");
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361: a review that blocked is never reused: the same prompt reviews again", async () => {
    const t = reusing(["block", "ok"]);
    await t.landRule("Refunds are fine.");
    expect(t.events("review.block")).toHaveLength(1);
    requeue(t.root);
    await reviewLandings(t.root);
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361: the key differs for another kind, review command, budget or prompt, and is the same for the same input", () => {
    const k = reviewKey("land", "cmd", 1024, ["a", "b"]);
    expect(reviewKey("land", "cmd", 1024, ["a", "b"])).toBe(k);
    expect(reviewKey("preview", "cmd", 1024, ["a", "b"])).not.toBe(k);
    expect(reviewKey("land", "cmd2", 1024, ["a", "b"])).not.toBe(k);
    expect(reviewKey("land", "cmd", 2048, ["a", "b"])).not.toBe(k);
    expect(reviewKey("land", "cmd", 1024, ["a", "c"])).not.toBe(k);
    expect(reviewKey("land", "cmd", 1024, ["ab"])).not.toBe(k); // two calls are not one
  });

  test("BR-2361: a passing preview is not a pass of the review after landing; a preview reuses a passing preview and prints the earlier notes", async () => {
    const t = reusing();
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    const p1 = await previewReview(ws(s.worktree), "guide");
    expect(p1.kind).toBe("ok");
    expect(t.runs()).toBe(1);
    const p2 = await previewReview(ws(s.worktree), "guide");
    expect(p2).toMatchObject({ kind: "ok", findings: [{ review: "rule", text: `${id} note 1` }] });
    expect(p2.kind === "ok" && p2.reusedFrom).toBeGreaterThan(0);
    expect(t.runs()).toBe(1); // preview reused the preview
    expect(t.events("review.preview")).toHaveLength(2);
    expect(JSON.parse(t.events("review.reused")[0]!.detail)).toMatchObject({ review: "preview" });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    await reviewLandings(t.root); // the review after landing does not reuse the preview
    expect(t.runs()).toBe(2);
    const reusedKinds = t.events("review.reused").map((e) => JSON.parse(e.detail).review);
    expect(reusedKinds).toEqual(["preview"]);
  }, 90_000);

  test("BR-2361: a later block of the same prompts wins over an earlier pass: the review command runs again", async () => {
    const t = reusing();
    await t.landRule("Refunds are fine.");
    const ok = JSON.parse(t.events("review.ok")[0]!.detail) as Record<string, unknown>;
    ws(t.root).db.event("agent:a", "review.block", "C-1", { ...ok, findings: ["a later block"] });
    requeue(t.root);
    await reviewLandings(t.root);
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361 BR-2359: a split review is reused only when every call passed: first call ok and second block is not reused, a later all-ok review is", async () => {
    const root = project();
    const base = join(root, "..", root.split("/").pop()!);
    const log = `${base}-split.log`;
    const script = `${base}-split.sh`;
    // calls 1 ok, 2 block, then every call ok
    writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho run >> ${log}\nn=$(wc -l < ${log} | tr -d ' ')\nif [ "$n" = 2 ]; then echo '{"verdict":"block","findings":["second blocks"]}'; else echo '{"verdict":"ok","findings":[]}'; fi\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview_max_prompt_kb: 20\nreview_parallel: 1\nreview: ${JSON.stringify(script)}\n`);
    const big = (n: number, tag: string) => `---\nid: ${["BR", n].join("-")}\ntitle: Big ${n}\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${tag} ${"x".repeat(9 * 1024)}\n\n## 例子\n\n- a → b\n`;
    for (const [path, text] of Object.entries({
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n",
      "canon/rules/billing/x/README.md": "# billing/x\n\n## 术语\n\n- **子域 X**：x\n\n## 业务\n\n- **x**：y\n",
      "canon/rules/billing/y/README.md": "# billing/y\n\n## 术语\n\n- **子域 Y**：y\n\n## 业务\n\n- **x**：y\n",
      "canon/rules/billing/x/BR-10.md": big(10, "TEXT-10"),
      "canon/rules/billing/y/BR-11.md": big(11, "TEXT-11"),
      "src/billing/.keep": "",
    })) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
    const count = (kind: string) => ws(root).db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind)?.n;
    const s = startNew(root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    await reviewLandings(root);
    expect(count("review.block")).toBe(1); // call 2 blocked
    expect(runs()).toBe(2);
    requeue(root);
    await reviewLandings(root); // the same prompts: not reused, both calls run and pass
    expect(runs()).toBe(4);
    expect(count("review.reused")).toBe(0);
    requeue(root);
    await reviewLandings(root); // now every call passed: reused
    expect(runs()).toBe(4);
    expect(count("review.reused")).toBe(1);
  }, 90_000);
});
