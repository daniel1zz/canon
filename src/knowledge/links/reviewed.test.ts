import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, reviewLandings, sh, startNew, ws } from "../../work/testkit.ts";
import { readCorpus } from "../documents/read.ts";
import { linksOf } from "./start.ts";

const quiet = () => {};
const rule = (n: number, text: string) => `---\nid: BR-${n}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\nbusiness: x\n---\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;

/** billing: BR-1, and BR-2 naming it; a reviewer with no findings; links_since before BR-2 named BR-1. */
function fixture() {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"findings\\":[]}'"\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, "canon/rules/billing/BR-1.md"), rule(1, "Refunds take three days."));
  // a stale record: BR-2's links names an old fingerprint of BR-1 (BR-2425)
  writeFileSync(join(root, "canon/rules/billing/BR-2.md"), rule(2, "A refund is announced as BR-1 says.").replace("business: x\n", "business: x\nlinks:\n  BR-1: 0123456789abcdef\n"));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "billing");
  const first = sh(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "echo '{\\"findings\\":[]}'"\nlinks_since: "${first}"\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "links_since");
  return root;
}

const suspects = (root: string) => {
  const l = linksOf(root, readCorpus(root).corpus, ws(root).config.linksSince);
  if (!l.ok) throw new Error(l.error.message);
  return l.value.filter((x) => x.suspect).map((x) => `${x.from} -> ${x.to}`);
};

test("BR-2539 BR-2425: once the review after a landing that changed a rule is done, the references naming it count as reviewed at its new text; a later change makes them suspect again; a stale links record does not outweigh the review", async () => {
  const root = fixture();
  const change = async (text: string) => {
    const s = startNew(root, `refunds ${text}`);
    writeFileSync(join(s.worktree, "canon/rules/billing/BR-1.md"), rule(1, text));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", text);
    const out = await land(ws(s.worktree), FAST, quiet);
    if (out.kind !== "landed") throw new Error(JSON.stringify(out));
  };
  await change("Refunds take five days.");
  expect(suspects(root)).toEqual(["BR-2 -> BR-1"]);
  await reviewLandings(root);
  expect(suspects(root)).toEqual([]);
  const db = ws(root).db;
  const reviewed = db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'link.reviewed'").all().map((r) => JSON.parse(r.detail));
  expect(reviewed).toEqual([expect.objectContaining({ from: "BR-2", to: "BR-1", fingerprint: expect.any(String) })]);
  expect(db.db.query("SELECT 1 FROM events WHERE kind = 'link.reviewed.backfill'").all()).toHaveLength(1);
  await change("Refunds take a week.");
  expect(suspects(root)).toEqual(["BR-2 -> BR-1"]);
  await reviewLandings(root);
  expect(suspects(root)).toEqual([]);
  expect(db.db.query("SELECT 1 FROM events WHERE kind = 'link.reviewed.backfill'").all()).toHaveLength(1);
});
