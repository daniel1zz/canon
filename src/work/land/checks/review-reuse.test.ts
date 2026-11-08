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
function reusing(verdicts: string[] = ["ok"], extraConfig = "") {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-runs.log`;
  const script = `${base}-reviewer.sh`;
  const marker = `${base}-hook-ran`;
  const answers = verdicts.map((v, i) => `[ "$n" = ${i + 1} ] && echo '{"verdict":"${v}","findings":["${id} note ${i + 1}"]}'`).join("\n");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho run >> ${log}\nn=$(wc -l < ${log} | tr -d ' ')\n${answers}\n[ "$n" -gt ${verdicts.length} ] && echo '{"verdict":"${verdicts[verdicts.length - 1]}","findings":["${id} note last"]}'\ntrue\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(script)}\n${extraConfig}hooks:\n  before_land: 'test -f ${marker} || { touch ${marker}; exit 1; }'\n`);
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
  const configOnMain = (config: string) => {
    writeFileSync(join(root, "canon/config.yaml"), config);
    sh(root, "commit", "-qam", "config");
  };
  return { root, runs, events, rule, script, marker, configOnMain };
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
    expect(said.join("\n")).toContain(`reused the passing review of the same prompts (event ${ok[0]!.id}, hash ${hash.slice(0, 12)}); the review command was not run`);
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

  /** The config a reusing() project has on main, with `review` and `extra` replaced. */
  const configWith = (t: ReturnType<typeof reusing>, review: string, extra: string) =>
    `floor: "true"\ntests: []\nreview: ${JSON.stringify(review)}\n${extra}hooks:\n  before_land: 'test -f ${t.marker} || { touch ${t.marker}; exit 1; }'\n`;

  test("BR-2361: a changed review command or a changed budget, through the landing, runs the review command again", async () => {
    for (const change of ["command", "budget"]) {
      const t = reusing();
      const s = startNew(t.root, "New rule");
      t.rule(s.worktree, "Refunds are fine.");
      expect((await land(ws(s.worktree), FAST, quiet)).kind === "refused").toBe(true); // review passed, the hook refused
      expect(t.runs()).toBe(1);
      t.configOnMain(change === "command" ? configWith(t, `${t.script} v2`, "") : configWith(t, t.script, "review_max_prompt_kb: 100\n"));
      expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
      expect(t.runs()).toBe(2);
      expect(t.events("review.reused")).toHaveLength(0);
    }
  }, 90_000);

  test("BR-2361: a landing's pass is not a preview pass: canon work review runs the review command after it", async () => {
    const t = reusing();
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    expect((await land(ws(s.worktree), FAST, quiet)).kind === "refused").toBe(true);
    expect(t.runs()).toBe(1);
    const p = await previewReview(ws(s.worktree), "guide");
    expect(p.kind === "ok" && p.reusedFrom).toBeUndefined();
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361: a later block of the same prompts wins over an earlier pass: the review command runs again", async () => {
    const t = reusing();
    const s = startNew(t.root, "New rule");
    t.rule(s.worktree, "Refunds are fine.");
    expect((await land(ws(s.worktree), FAST, quiet)).kind === "refused").toBe(true); // pass recorded
    const ok = JSON.parse(t.events("review.ok")[0]!.detail) as Record<string, unknown>;
    ws(t.root).db.event("agent:a", "review.block", "C-1", { ...ok, findings: ["a later block"] });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(t.runs()).toBe(2);
    expect(t.events("review.reused")).toHaveLength(0);
  }, 60_000);

  test("BR-2361 BR-2359: a split review is reused only when every call passed: first call ok and second block is not reused, a later all-ok review is", async () => {
    const root = project();
    const base = join(root, "..", root.split("/").pop()!);
    const log = `${base}-split.log`;
    const script = `${base}-split.sh`;
    const marker = `${base}-split-hook`;
    // calls 1 ok, 2 block, then every call ok
    writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho run >> ${log}\nn=$(wc -l < ${log} | tr -d ' ')\nif [ "$n" = 2 ]; then echo '{"verdict":"block","findings":["second blocks"]}'; else echo '{"verdict":"ok","findings":[]}'; fi\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview_max_prompt_kb: 20\nreview: ${JSON.stringify(script)}\nhooks:\n  before_land: 'test -f ${marker} || { touch ${marker}; exit 1; }'\n`);
    const big = (n: number, tag: string) => `---\nid: ${["BR", n].join("-")}\ntitle: Big ${n}\nuntested: demo\n---\n## 规则\n\n${tag} ${"x".repeat(9 * 1024)}\n\n## 例子\n\n- a → b\n`;
    for (const [path, text] of Object.entries({
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
      "canon/rules/billing/x/README.md": "# billing/x\n\n## 术语\n\n- **子域 X**：x\n",
      "canon/rules/billing/y/README.md": "# billing/y\n\n## 术语\n\n- **子域 Y**：y\n",
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
    const reused = () => ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.reused'").get()?.n;
    const s = startNew(root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), ruleText("Refunds are fine."));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const first = await land(ws(s.worktree), FAST, quiet);
    expect(first.kind === "refused" && first.reason).toBe("review"); // call 2 blocked
    expect(runs()).toBe(2);
    const second = await land(ws(s.worktree), FAST, quiet); // the same prompts: not reused, both calls run and pass; the hook refuses
    expect(second.kind === "refused" && second.reason).toBe("hook");
    expect(runs()).toBe(4);
    expect(reused()).toBe(0);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed"); // now every call passed: reused
    expect(runs()).toBe(4);
    expect(reused()).toBe(1);
  }, 90_000);
});
