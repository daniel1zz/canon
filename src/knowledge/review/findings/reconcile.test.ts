import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../../work/testkit.ts";
import type { CoordDb } from "../../../work/db.ts";
import { recordFindings, sameDocsOpen, type Finding } from "./findings.ts";
import { reconcileFindings } from "./reconcile.ts";

const BR = (n: number) => `BR-${n}`;
const ruleFile = (n: number) => `---\nid: ${BR(n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nRule ${n}.\n\n## 例子\n\n- a → b\n`;
const f = (criterion: string, text: string): Finding => ({ criterion, text });

/** A repo whose main configures a controllable reviewer: it saves the prompt and its CANON_REVIEW_KIND, then prints answer.json. */
function fixture(review = `"printf '%s' \\"$CANON_REVIEW_KIND\\" > kind.txt; tee prompt.txt > /dev/null; cat answer.json"`) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${review}\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  for (const n of [1, 2, 3]) writeFileSync(join(root, `canon/rules/billing/${BR(n)}.md`), ruleFile(n));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "billing");
  const db = ws(root).db;
  const event = db.event("agent:x", "review.block", "C-9", {});
  const r = recordFindings(db, {
    findings: [f("contradiction", `${BR(1)} 和 ${BR(2)} 的「三天」矛盾`), f("restatement", `${BR(1)} 复述了 ${BR(2)} 的退款期限`), f("untestable", `${BR(3)} 没有边界`)],
    reviewed: [], change: "C-9", event, sha: sh(root, "rev-parse", "main"),
  });
  if (!r.ok) throw new Error(r.error.message);
  const [a, b, other] = r.value.opened as [number, number, number];
  const answer = (v: unknown) => writeFileSync(join(root, "answer.json"), JSON.stringify(v));
  const input = (x: number | string, y: number | string) => ({ cwd: root, main: "main", actor: "agent:test", a: String(x), b: String(y) });
  return { root, db, a, b, other, answer, input };
}

const questionOf = (db: CoordDb, id: number) => db.db.query<{ question: number | null }, [number]>("SELECT question FROM review_findings WHERE id = ?").get(id)!.question;

describe("canon finding reconcile (BR-2461)", () => {
  test("BR-2461: a compatible pair changes nothing; the review gets both findings, their documents and kind reconcile", async () => {
    const { root, db, a, b, answer, input } = fixture();
    answer({ opposed: false, reason: "two different sentences" });
    const r = await reconcileFindings(db, input(a, `#${b}`));
    expect(r.ok && r.value).toEqual({ kind: "not-opposed", reason: "two different sentences" });
    const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
    expect(prompt).toContain(`Finding #${a}`);
    expect(prompt).toContain("「三天」矛盾");
    expect(prompt).toContain("Document BR-1");
    expect(prompt).toContain("Rule 2.");
    expect(readFileSync(join(root, "kind.txt"), "utf8")).toBe("reconcile");
    const ev = db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'finding.reconcile'").get()!;
    expect(JSON.parse(ev.detail)).toEqual({ findings: [a, b], opposed: false, reason: "two different sentences" });
    expect([questionOf(db, a), questionOf(db, b)]).toEqual([null, null]);
  });

  test("BR-2461: an opposed pair with a wording prints it and closes nothing; without one it records the owner's question once", async () => {
    const { db, a, b, answer, input } = fixture();
    answer({ opposed: true, wording: "BR-1 keeps the limit, BR-2 names it", reason: "both hold" });
    const w = await reconcileFindings(db, input(a, b));
    expect(w.ok && w.value).toEqual({ kind: "wording", wording: "BR-1 keeps the limit, BR-2 names it", reason: "both hold" });
    expect([questionOf(db, a), questionOf(db, b)]).toEqual([null, null]);
    answer({ opposed: true, reason: "the demands exclude each other" });
    const q = await reconcileFindings(db, input(a, b));
    if (!q.ok || q.value.kind !== "question") throw new Error("expected a question");
    const question = q.value.question;
    expect([questionOf(db, a), questionOf(db, b)]).toEqual([question, question]);
    const row = db.db.query<{ question: string; answer: string | null }, [number]>("SELECT question, answer FROM questions WHERE id = ?").get(question)!;
    expect(row.answer).toBeNull();
    expect(row.question).toContain(`#${a}`);
    expect(row.question).toContain("「三天」矛盾");
    const again = await reconcileFindings(db, input(a, b));
    expect(!again.ok && [again.error.code, again.error.message.includes(`#${question}`)]).toEqual(["conflict", true]);
    db.db.query("UPDATE questions SET answer = ?, answered_by = ? WHERE id = ?").run("keep BR-1", "human:owner", question);
    answer({ opposed: false, reason: "after the verdict the texts agree" });
    const after = await reconcileFindings(db, input(a, b));
    expect(after.ok && after.value.kind).toBe("not-opposed");
  });

  test("BR-2461: bad numbers, a missing finding, no shared document, and no review command are refused in that order", async () => {
    const { root, db, a, b, other, input } = fixture();
    expect((await reconcileFindings(db, input("x", b))).ok).toBe(false);
    const same = await reconcileFindings(db, input(a, a));
    expect(!same.ok && same.error.code).toBe("invalid");
    const gone = await reconcileFindings(db, input(a, 999));
    expect(!gone.ok && gone.error.code).toBe("not_found");
    const apart = await reconcileFindings(db, input(a, other));
    expect(!apart.ok && [apart.error.code, apart.error.message.includes("share no document")]).toEqual(["invalid", true]);
    const broken = await reconcileFindings(db, input(a, b));
    expect(!broken.ok && broken.error.code).toBe("io");
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\n');
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "no reviewer");
    const none = await reconcileFindings(db, input(a, b));
    expect(!none.ok && [none.error.code, none.error.message.includes("review")]).toEqual(["io", true]);
    rmSync(join(root, "answer.json"), { force: true });
  });

  test("BR-2461: recording a finding whose documents equal an open finding's names the reconcile pair", () => {
    const { db, a, b, other } = fixture();
    expect(sameDocsOpen(db, b)).toEqual([a]);
    expect(sameDocsOpen(db, other)).toEqual([]);
    db.db.query("UPDATE review_findings SET closed_at = ?, closed_how = 'fixed' WHERE id = ?").run(new Date().toISOString(), a);
    expect(sameDocsOpen(db, b)).toEqual([]);
  });
});
