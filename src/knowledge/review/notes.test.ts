import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, reviewLandings, sh, startNew, ws } from "../../work/testkit.ts";
import { names, notesByDoc, openNotes } from "./notes.ts";

const id = (n: number) => ["BR", n].join("-");

/** canon/config.yaml whose reviewer answers `ok` with the given notes; `hook` is a before_land command. */
function config(notes: readonly string[], hook?: string): string {
  const answer = JSON.stringify({ verdict: "ok", findings: notes }).replaceAll('"', '\\"');
  return `floor: "true"\ntests: []\nreview: "echo '${answer}'"\n${hook ? `hooks:\n  before_land: "${hook}"\n` : ""}`;
}

/** A project with a billing domain and that reviewer. */
function reviewed(notes: readonly string[]) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), config(notes));
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "domain");
  return root;
}

function setReviewer(root: string, notes: readonly string[], hook?: string) {
  writeFileSync(join(root, "canon/config.yaml"), config(notes, hook));
  sh(root, "commit", "-qam", "reviewer");
}

/** Lands a change that writes the given rules and runs the review after it (BR-2441), returning what both said. */
async function landRules(root: string, title: string, rules: readonly number[]) {
  const s = startNew(root, title);
  for (const n of rules) writeFileSync(join(s.worktree, `canon/rules/billing/${id(n)}.md`), `---\nid: ${id(n)}\ntitle: R${n} ${title}\nuntested: demo\nbusiness: x\n---\n## 规则\n\n${title} ${n}.\n\n## 例子\n\n- a → b\n`);
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const lines: string[] = [];
  const out = await land(ws(s.worktree), FAST, (l) => lines.push(l));
  lines.push(...(await reviewLandings(root)));
  return { out, lines, change: s.change };
}

describe("review notes", () => {
  test("BR-2145: a note goes to each reviewed document it names by whole id, or to all of them when it names none", () => {
    expect(names(`${id(201)} is vague`, id(20))).toBe(false);
    expect(names(`${id(201)} is vague`, id(201))).toBe(true);
    const by = notesByDoc([id(20), id(201)], [`${id(201)} 的例子缺少边界另一侧`, "措辞可以更短"]);
    expect(by.get(id(20))).toEqual(["措辞可以更短"]);
    expect(by.get(id(201))).toEqual([`${id(201)} 的例子缺少边界另一侧`, "措辞可以更短"]);
  });

  test("BR-2145: the review after a landing records its notes; a later review of a document replaces them; a refused landing changes nothing", async () => {
    const root = reviewed([`${id(1)} 的例子缺少边界另一侧`, "措辞可以更短"]);
    const first = await landRules(root, "First", [1, 2]);
    expect(first.out.kind).toBe("landed");
    expect(first.lines.join("\n")).toContain("review notes do not block and are not changes of their own");
    const db = ws(root).db;
    expect(openNotes(db, [id(1)]).map((n) => n.note)).toEqual([`${id(1)} 的例子缺少边界另一侧`, "措辞可以更短"]);
    expect(openNotes(db, [id(2)]).map((n) => n.note)).toEqual(["措辞可以更短"]);
    expect(openNotes(db, [id(1)])[0]!.change).toBe(first.change);

    // A refused landing (before_land fails) queues no review, so it records nothing.
    setReviewer(root, [`${id(1)} still vague`], "exit 1");
    const refused = await landRules(root, "Refused", [1]);
    expect(refused.out.kind === "refused" && refused.out.reason).toBe("hook");
    expect(openNotes(ws(root).db, [id(1)]).map((n) => n.note)).toEqual([`${id(1)} 的例子缺少边界另一侧`, "措辞可以更短"]);

    // A later review of BR-1 with no notes replaces BR-1's; BR-2's stay.
    setReviewer(root, []);
    const again = await landRules(root, "Again", [1]);
    expect(again.out.kind).toBe("landed");
    expect(again.lines.join("\n")).not.toContain("review notes do not block");
    expect(openNotes(ws(root).db, [id(1)])).toEqual([]);
    expect(openNotes(ws(root).db, [id(2)]).map((n) => n.note)).toEqual(["措辞可以更短"]);
  });
});
