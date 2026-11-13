import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, reviewLandings, sh, startNew, ws } from "../../work/testkit.ts";
import { readCorpus } from "../documents/read.ts";
import { recordFindings, type Finding } from "../review/findings/findings.ts";
import { accept, ACCEPTED_REF } from "./accept.ts";

const quiet = () => {};
const f = (criterion: string, text: string): Finding => ({ criterion, text });

/** A billing project whose reviewer answers with no findings, so landings review clean (BR-2441). */
function fixture() {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"findings\\":[]}'"\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, "canon/rules/billing/BR-1.md"), rule(1));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "billing");
  const first = sh(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"findings\\":[]}'"\nlinks_since: "${first}"\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "links_since");
  return root;
}
const rule = (n: number, extra = "") => `---\nid: BR-${n}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nRule ${n}.${extra}\n\n## 例子\n\n- a → b\n`;

async function landRule(root: string, title: string, text: string) {
  const s = startNew(root, title);
  writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), text);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const out = await land(ws(s.worktree), FAST, quiet);
  if (out.kind !== "landed") throw new Error(`landing failed: ${JSON.stringify(out)}`);
  return out;
}

const run = (root: string) => accept(ws(root), quiet, readCorpus(root));

describe("canon accept (BR-2462)", () => {
  test("BR-2462: a clean, reviewed, tested project is accepted; the ref moves forward and a repeat changes nothing", async () => {
    const root = fixture();
    await landRule(root, "narrow", rule(1, " Only overseas."));
    await reviewLandings(root);
    const r = await run(root);
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.reasons, r.value.waiting, r.value.verdicts]).toEqual([[], [], []]);
    const tip = sh(root, "rev-parse", "main");
    expect(sh(root, "rev-parse", ACCEPTED_REF)).toBe(tip);
    const db = ws(root).db;
    expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'accept.ok'").get()!.n).toBe(1);
    const again = await run(root);
    expect(again.ok && again.value.reasons).toEqual([]);
    expect(sh(root, "rev-parse", ACCEPTED_REF)).toBe(tip);
  });

  test("BR-2462: open findings, verdict-awaiting findings, suspect references and a pending review are all listed at once", async () => {
    const root = fixture();
    await landRule(root, "narrow", rule(1, " Only overseas."));
    const db = ws(root).db;
    const event = db.event("agent:x", "review.block", "C-9", {});
    const rec = recordFindings(db, { findings: [f("contradiction", "BR-1 的「三天」矛盾"), f("restatement", "BR-1 复述了别处")], reviewed: [], change: "C-9", event, sha: sh(root, "rev-parse", "main") });
    if (!rec.ok) throw new Error(rec.error.message);
    const [plain, awaiting] = rec.value.opened as [number, number];
    db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, asked_at) VALUES (NULL, 'agent:x', 'which way?', '[]', 0, ?)").run(new Date().toISOString());
    const q = Number(db.db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM questions").get()!.id);
    db.db.query("UPDATE review_findings SET question = ? WHERE id = ?").run(q, awaiting);
    const r = await run(root);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.verdicts).toEqual([{ finding: awaiting, question: q, text: "BR-1 复述了别处" }]);
    expect(r.value.reasons.some((x) => x.includes(`#${plain}`))).toBe(true);
    expect(r.value.reasons.some((x) => x.includes("awaiting the owner's verdict"))).toBe(true);
    expect(r.value.waiting.some((x) => x.includes("queued") || x.includes("running"))).toBe(true);
    expect(sh(root, "rev-parse", "main")).not.toBe("");
  });

  test("BR-2462: a failed landed review and a doc commit without one are reasons; done reviews clear them", async () => {
    const root = fixture();
    await landRule(root, "narrow", rule(1, " Only overseas."));
    await reviewLandings(root);
    const first = await run(root);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.reasons).toEqual([]);
    await landRule(root, "wider", rule(1, " Everywhere."));
    const db = ws(root).db;
    db.db.query("UPDATE landed_reviews SET state = 'failed', finished_at = ? WHERE state = 'queued'").run(new Date().toISOString());
    const failed = await run(root);
    if (!failed.ok) throw new Error(failed.error.message);
    expect(failed.value.reasons.some((x) => x.includes("--again"))).toBe(true);
    db.db.query("UPDATE landed_reviews SET state = 'done' WHERE state = 'failed'").run();
    const done = await run(root);
    expect(done.ok && done.value.reasons).toEqual([]);
  });

  test("BR-2462: a review covers every commit of its landing, and a landing that changed only links records needs none", async () => {
    const root = fixture();
    await reviewLandings(root);
    const s = startNew(root, "two commits");
    writeFileSync(join(s.worktree, "canon/rules/billing/BR-2.md"), rule(2, " After BR-1."));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "add BR-2");
    writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), rule(1, " Only overseas."));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "narrow BR-1");
    const out = await land(ws(s.worktree), FAST, quiet);
    if (out.kind !== "landed") throw new Error(`landing failed: ${JSON.stringify(out)}`);
    await reviewLandings(root);
    const both = await run(root);
    if (!both.ok) throw new Error(both.error.message);
    expect(both.value.reasons.filter((x) => x.includes("no review after its landing") || x.includes("failed"))).toEqual([]);
    const db = ws(root).db;
    const rows = () => db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM landed_reviews").get()!.n;
    const before = rows();
    const c = startNew(root, "links only");
    const text = rule(2, " After BR-1.").replace("business: x\n", "business: x\nlinks:\n  BR-1: 0123456789abcdef\n");
    writeFileSync(join(c.worktree, "canon/rules/billing/BR-2.md"), text);
    sh(c.worktree, "add", "-A");
    sh(c.worktree, "commit", "-qm", "confirm");
    const linked = await land(ws(c.worktree), FAST, quiet);
    if (linked.kind !== "landed") throw new Error(`landing failed: ${JSON.stringify(linked)}`);
    expect(rows()).toBe(before);
    const after = await run(root);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.reasons.filter((x) => x.includes("no review after its landing"))).toEqual([]);
  });

  test("BR-2462: with floor_timing after, an untested tip runs the floor at once and is accepted when it passes", async () => {
    const root = fixture();
    const first = sh(root, "rev-parse", "HEAD~1");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"findings\\":[]}'"\nlinks_since: "${first}"\nfloor_timing: after\nfloor_quiet_minutes: 0\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "after mode");
    const r = await run(root);
    if (!r.ok) throw new Error(r.error.message);
    expect([r.value.reasons, r.value.waiting]).toEqual([[], []]);
    expect(sh(root, "rev-parse", ACCEPTED_REF)).toBe(sh(root, "rev-parse", "main"));
    expect(sh(root, "rev-parse", "refs/canon/green")).toBe(sh(root, "rev-parse", "main"));
  });

  test("BR-2462: a dirty checkout or one not on main's tip is an environment error, nothing checked", async () => {
    const root = fixture();
    writeFileSync(join(root, "loose.txt"), "x\n");
    const dirty = await run(root);
    expect(!dirty.ok && [dirty.error.code, dirty.error.message.includes("uncommitted")]).toEqual(["io", true]);
    sh(root, "rm", "--cached", "--quiet", "--ignore-unmatch", "loose.txt");
    sh(root, "checkout", "-q", "HEAD~1");
    const behind = await run(root);
    expect(!behind.ok && [behind.error.code, behind.error.message.includes("check out")]).toEqual(["io", true]);
    const db = ws(root).db;
    expect(db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'accept.ok'").get()!.n).toBe(0);
  });
});
