import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { previewReview } from "../../../knowledge/review/preview.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { reviewKey } from "./review-reuse.ts";

const id = ["BR", 1].join("-");
const ruleText = (text: string) => `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

/** billing with a counting reviewer (`verdicts` are its answers in turn, the last repeats) and a before_land hook that fails once. */
function reusing(verdicts: string[] = ["ok"]) {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-runs.log`;
  const script = `${base}-reviewer.sh`;
  const marker = `${base}-hook-ran`;
  const answers = verdicts.map((v, i) => `[ "$n" = ${i + 1} ] && echo '{"verdict":"${v}","findings":["${id} note ${i + 1}"]}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho run >> ${log}\nn=$(wc -l < ${log} | tr -d ' ')\n${answers}\n[ "$n" -gt ${verdicts.length} ] && echo '{"verdict":"${verdicts[verdicts.length - 1]}","findings":["${id} note last"]}'\ntrue\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\nhooks:\n  before_land: 'test -f ${marker} || { touch ${marker}; exit 1; }'\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
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
  return { root, runs, events, rule };
}

describe("reusing a passed rule review (BR-2361)", () => {
  test("BR-2361: a landing refused after its review passed lands on retry without calling the review command again, and records review.reused with the hash", async () => {
    const t = reusing();
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    const first = await land(ws(s.worktree), FAST, quiet);
    expect(first.kind === "refused" && first.reason).toBe("hook");
    expect(t.runs()).toBe(1);
    const ok = t.events("review.ok");
    const hash = JSON.parse(ok[0]!.detail).hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const said: string[] = [];
    const second = await land(ws(s.worktree), FAST, (l) => said.push(l));
    expect(second.kind).toBe("landed");
    expect(t.runs()).toBe(1);
    expect(said.join("\n")).toContain("reused the passing review");
    expect(said.join("\n")).toContain(`${id} note 1`); // the note of the first review is still handed on
    const reused = t.events("review.reused");
    expect(reused).toHaveLength(1);
    expect(JSON.parse(reused[0]!.detail)).toMatchObject({ review: "land", hash, docs: [id], from: ok[0]!.id });
  }, 60_000);

  test("BR-2361: changing one word of the reviewed text runs the review command again and records no review.reused", async () => {
    const t = reusing();
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    await land(ws(s.worktree), FAST, quiet);
    t.rule(s.worktree, "Refunds are fine!");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361: a review that blocked is never reused: the same prompt reviews again", async () => {
    const t = reusing(["block", "ok"]);
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    const first = await land(ws(s.worktree), FAST, quiet);
    expect(first.kind === "refused" && first.reason).toBe("review");
    expect((await land(ws(s.worktree), FAST, quiet)).kind === "refused").toBe(true); // the hook fails the first time it runs
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

  test("BR-2361: a passing preview is not a landing pass; a preview reuses a passing preview and prints the earlier notes", async () => {
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
    await land(ws(s.worktree), FAST, quiet); // the landing does not reuse the preview
    expect(t.runs()).toBe(2);
    const reusedKinds = t.events("review.reused").map((e) => JSON.parse(e.detail).review);
    expect(reusedKinds).toEqual(["preview"]);
  }, 90_000);
});
