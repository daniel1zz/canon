import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

const KB = 1024;
const bigRule = (n: number, title: string, tag: string) => `---\nid: ${["BR", n].join("-")}\ntitle: ${title}\nuntested: demo\n---\n## 规则\n\n${tag} ${"x".repeat(9 * KB)}\n\n## 例子\n\n- a → b\n`;

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
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "canon/rules/billing/x/README.md": "# billing/x\n\n## 术语\n\n- **子域 X**：x\n",
    "canon/rules/billing/y/README.md": "# billing/y\n\n## 术语\n\n- **子域 Y**：y\n",
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
    writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), `---\nid: BR-1\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nCHANGED-1 refunds are fine.${extra}\n\n## 例子\n\n- a → b\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    return s;
  };
  const prompts = () => readdirSync(dir).filter((f) => f.startsWith("p.")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
  return { root, change, prompts, dir };
}

describe("rule review split by size at land (BR-2359, D-67)", () => {
  test("BR-2009 BR-2359: a review over review_max_prompt_kb runs as several calls, each with the changed rule and under the budget; the landing says how many and how big", async () => {
    const { change, prompts } = splitProject(20, "ok");
    const s = change();
    const lines: string[] = [];
    const out = await land(ws(s.worktree), FAST, (l: string) => void lines.push(l));
    expect(out.kind).toBe("landed");
    const calls = prompts();
    expect(calls).toHaveLength(2);
    for (const p of calls) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(20 * KB);
      expect(p).toContain("CHANGED-1");
    }
    expect(calls.filter((p) => p.includes("TEXT-10"))).toHaveLength(1);
    expect(calls.filter((p) => p.includes("TEXT-11"))).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/review: split into 2 calls by size \(review_max_prompt_kb\): 1: \d+ KB, 2: \d+ KB/);
  });

  test("BR-2359: with a big enough budget the review is one call and the landing does not mention a split", async () => {
    const { change, prompts } = splitProject(250, "ok");
    const lines: string[] = [];
    const out = await land(ws(change().worktree), FAST, (l: string) => void lines.push(l));
    expect(out.kind).toBe("landed");
    expect(prompts()).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("split into");
  });

  test("BR-2359: a block in the second call refuses the landing with the findings of both calls, each once", async () => {
    const { change, prompts } = splitProject(20, "block2");
    const out = await land(ws(change().worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toContain("second blocks");
    expect(message.split("same note").length - 1).toBe(1);
    expect(prompts()).toHaveLength(2);
  });

  test("BR-2359 BR-2216: a call that fails refuses the landing at once; the later calls do not run", async () => {
    const { change, prompts } = splitProject(20, "fail1");
    const out = await land(ws(change().worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("first call failed");
    expect(prompts()).toHaveLength(1);
  });

  test("BR-2359: the review's fixed part alone over the budget refuses the landing with reason review, the sizes and the remedy that fits (splitting the change cannot help); the reviewer never runs", async () => {
    const { change, prompts, dir } = splitProject(2, "ok");
    const out = await land(ws(change().worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toMatch(/cannot be made smaller than \d+ KB.*review_max_prompt_kb = 2 KB; sizes: changed documents \d+ KB, .* \d+ KB, domain text 0 KB/);
    expect(message).toContain("splitting the change cannot help");
    expect(message).toContain("raise review_max_prompt_kb");
    expect(message).not.toContain("several smaller changes");
    expect(prompts()).toHaveLength(0);
    expect(existsSync(join(dir, "review.sh"))).toBe(true);
  });

  test("BR-2359: changed documents that are the large part refuse the landing with the advice to land several smaller changes; the reviewer never runs", async () => {
    const { change, prompts } = splitProject(20, "ok");
    const out = await land(ws(change(` ${"z".repeat(25 * KB)}`).worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toMatch(/review_max_prompt_kb = 20 KB; sizes: changed documents 2\d KB/);
    expect(message).toContain("land the changed documents in several smaller changes");
    expect(prompts()).toHaveLength(0);
  });
});
