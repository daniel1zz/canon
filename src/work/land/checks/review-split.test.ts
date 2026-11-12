import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, reviewLandings, sh, startNew, ws } from "../../testkit.ts";

const KB = 1024;
const bigRule = (n: number, title: string, tag: string) => `---\nid: ${["BR", n].join("-")}\ntitle: ${title}\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${tag} ${"x".repeat(9 * KB)}\n\n## 例子\n\n- a → b\n`;

/**
 * A project whose billing domain has two subdomains of one 9 KB rule each, and a reviewer script that keeps the prompt of
 * call n in `dir/p.n`: in mode `block2` the second call blocks, in mode `fail1` the first exits 1.
 */
function splitProject(maxKb: number, mode: "ok" | "block2" | "fail1") {
  const root = project();
  const dir = join(root, "..", `${root.split("/").pop()}-calls`);
  mkdirSync(dir);
  const script = join(dir, "review.sh");
  writeFileSync(
    script,
    `d="$1"; mode="$2"; n=$(ls "$d" | grep -c '^p\\.'); n=$((n+1)); cat > "$d/p.$n"
[ "$mode" = fail1 ] && [ "$n" = 1 ] && { echo "first call failed" >&2; exit 1; }
if [ "$mode" = block2 ] && [ "$n" = 2 ]; then echo '{"verdict":"block","findings":["second blocks","same note"]}'; else echo '{"verdict":"ok","findings":["same note"]}'; fi
`,
  );
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview_max_prompt_kb: ${maxKb}\n# the script numbers the calls as they arrive, so they run one after another\nreview_parallel: 1\nreview: 'sh ${script} ${dir} ${mode}'\n`);
  for (const [path, text] of Object.entries({
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n",
    "canon/rules/billing/x/README.md": "# billing/x\n\n## 术语\n\n- **子域 X**：x\n\n## 业务\n\n- **x**：y\n",
    "canon/rules/billing/y/README.md": "# billing/y\n\n## 术语\n\n- **子域 Y**：y\n\n## 业务\n\n- **x**：y\n",
    "canon/rules/billing/x/BR-10.md": bigRule(10, "Rule ten", "TEXT-10"),
    "canon/rules/billing/y/BR-11.md": bigRule(11, "Rule eleven", "TEXT-11"),
    "src/billing/.keep": "",
  })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const change = (extra = "") => {
    const s = startNew(root, "New rule");
    writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), `---\nid: BR-1\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nCHANGED-1 refunds are fine.${extra}\n\n## 例子\n\n- a → b\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    return s;
  };
  const prompts = () => readdirSync(dir).filter((f) => f.startsWith("p.")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
  /** Lands `wt` and runs the review after it (BR-2441): the landing's outcome, what the review said, and its event kinds. */
  const landReviewed = async (wt: string) => {
    const out = await land(ws(wt), FAST, () => {});
    const review = (await reviewLandings(root)).join("\n");
    const kinds = ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'review.%' ORDER BY id").all().map((e) => e.kind);
    return { out, review, kinds };
  };
  return { root, change, prompts, dir, landReviewed };
}

describe("rule review split by size after landing (BR-2359, D-67)", () => {
  test("BR-2009 BR-2359: a review over review_max_prompt_kb runs as several calls, each with the changed rule and under the budget; the review says how many and how big", async () => {
    const { change, prompts, landReviewed } = splitProject(20, "ok");
    const { out, review } = await landReviewed(change().worktree);
    expect(out.kind).toBe("landed");
    const calls = prompts();
    expect(calls).toHaveLength(2);
    for (const p of calls) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(20 * KB);
      expect(p).toContain("CHANGED-1");
    }
    expect(calls.filter((p) => p.includes("TEXT-10"))).toHaveLength(1);
    expect(calls.filter((p) => p.includes("TEXT-11"))).toHaveLength(1);
    expect(review).toMatch(/review: split into 2 calls by size \(review_max_prompt_kb\): 1: \d+ KB, 2: \d+ KB/);
  });

  test("BR-2359: with a big enough budget the review is one call and does not mention a split", async () => {
    const { change, prompts, landReviewed } = splitProject(250, "ok");
    const { out, review } = await landReviewed(change().worktree);
    expect(out.kind).toBe("landed");
    expect(prompts()).toHaveLength(1);
    expect(review).not.toContain("split into");
  });

  test("BR-2359: a block in the second call makes the review a block with the findings of both calls, each once; the change has landed", async () => {
    const { change, prompts, landReviewed } = splitProject(20, "block2");
    const { out, review, kinds } = await landReviewed(change().worktree);
    expect(out.kind).toBe("landed");
    expect(kinds).toEqual(["review.block"]);
    expect(review).toContain("second blocks");
    expect(review.split("same note").length - 1).toBe(1);
    expect(prompts()).toHaveLength(2);
  });

  test("BR-2359 BR-2216: a call that fails fails the review at once; the later calls do not run", async () => {
    const { change, prompts, landReviewed } = splitProject(20, "fail1");
    const { out, review, kinds } = await landReviewed(change().worktree);
    expect(out.kind).toBe("landed");
    expect(kinds).toEqual(["review.fail"]);
    expect(review).toContain("review: could not run: ");
    expect(review).toContain("first call failed");
    expect(prompts()).toHaveLength(1);
  });

  test("BR-2359: the review's fixed part alone over the budget fails the review with the sizes and the remedy that fits (splitting the change cannot help); the reviewer never runs", async () => {
    const { change, prompts, dir, landReviewed } = splitProject(2, "ok");
    const { out, review: message, kinds } = await landReviewed(change().worktree);
    expect(out.kind).toBe("landed");
    expect(kinds).toEqual(["review.fail"]);
    expect(message).toMatch(/cannot be made smaller than \d+ KB[\s\S]*review_max_prompt_kb = 2 KB; sizes: changed documents \d+ KB, .* \d+ KB, domain text 0 KB/);
    expect(message).toContain("splitting the change cannot help");
    expect(message).toContain("raise review_max_prompt_kb");
    expect(message).not.toContain("several smaller changes");
    expect(prompts()).toHaveLength(0);
    expect(existsSync(join(dir, "review.sh"))).toBe(true);
  });

  test("BR-2359: changed documents that are the large part fail the review with the advice to land several smaller changes; the reviewer never runs", async () => {
    const { change, prompts, landReviewed } = splitProject(20, "ok");
    const { out, review: message, kinds } = await landReviewed(change(` ${"z".repeat(25 * KB)}`).worktree);
    expect(out.kind).toBe("landed");
    expect(kinds).toEqual(["review.fail"]);
    expect(message).toMatch(/review_max_prompt_kb = 20 KB; sizes: changed documents 2\d KB/);
    expect(message).toContain("land the changed documents in several smaller changes");
    expect(prompts()).toHaveLength(0);
  });
});
