import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { land } from "../land.ts";
import { previewReview } from "../../../knowledge/review/preview.ts";
import { runReview, runReviews } from "../../../knowledge/review/review.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

const id = ["BR", 1].join("-");

/** A project whose reviewer appends `$CANON_REVIEW_KIND` to a log, one line per run. */
function kindProject() {
  const root = project();
  const base = join(root, "..", root.split("/").pop()!);
  const log = `${base}-kinds.log`;
  const script = `${base}-reviewer.sh`;
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho "\${CANON_REVIEW_KIND:-unset}" >> ${log}\necho '{"verdict":"ok","findings":[]}'\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\ninstructions: [CLAUDE.md]\nreview: ${JSON.stringify(script)}\n`);
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nRun the tests.\n");
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  const kinds = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const change = (claudeLine = false) => {
    const s = startNew(root, "New rule");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n\n## 例子\n\n- a → b\n`);
    if (claudeLine) writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nRun the tests.\n\nRun them twice.\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    return s;
  };
  return { root, kinds, change };
}

describe("CANON_REVIEW_KIND (BR-2366)", () => {
  test("BR-2366: the review command of a landing runs with CANON_REVIEW_KIND=land", async () => {
    const t = kindProject();
    expect((await land(ws(t.change().worktree), FAST, quiet)).kind).toBe("landed");
    expect(t.kinds()).toEqual(["land"]);
  }, 60_000);

  test("BR-2366: canon work review runs the rule review and the duplicate review with CANON_REVIEW_KIND=preview, whatever the caller's environment says", async () => {
    const t = kindProject();
    const s = t.change(true);
    process.env["CANON_REVIEW_KIND"] = "land";
    try {
      expect((await previewReview(ws(s.worktree), "guide")).kind).toBe("ok");
    } finally {
      delete process.env["CANON_REVIEW_KIND"];
    }
    expect(t.kinds()).toEqual(["preview", "preview"]);
  }, 60_000);

  test("BR-2366: a landing with a rule and a standing-instruction change runs both reviews with land; a preview pass is still not reused by it", async () => {
    const t = kindProject();
    const s = t.change(true);
    expect((await previewReview(ws(s.worktree), "guide")).kind).toBe("ok");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(t.kinds()).toEqual(["preview", "preview", "land", "land"]);
  }, 60_000);

  test("BR-2366: every call of a review split into several runs with the same kind; a command that ignores the variable is judged as before", async () => {
    const out = join(tmpdir(), `canon-kind-${process.pid}.log`);
    const cmd = `cat > /dev/null; echo "$CANON_REVIEW_KIND" >> ${out}; echo '{"verdict":"ok","findings":[]}'`;
    const r = await runReviews(cmd, tmpdir(), ["one", "two"], { timeoutMs: 60_000, kind: "land" });
    expect(r).toEqual({ ok: true, value: { verdict: "ok", findings: [] } });
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["land", "land"]);
    const ignoring = await runReview(`cat > /dev/null; echo '{"verdict":"block","findings":["x"]}'`, tmpdir(), "p", { timeoutMs: 60_000, kind: "preview" });
    expect(ignoring).toEqual({ ok: true, value: { verdict: "block", findings: ["x"] } });
  });
});
