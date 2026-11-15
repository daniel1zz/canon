import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../../work/testkit.ts";
import { readCorpus } from "../../documents/read.ts";
import { designStats, renderDesignStats } from "../../../work/stats/design.ts";
import { reviewPrompt } from "../../review/review.ts";
import { DEFAULT_DESIGN_SIGNALS, designBasisNote, revisionReasonFindings, touchedClasses } from "./design-basis.ts";

const changeFile = (wt: string, id: string) => {
  const dir = join(wt, "canon/changes");
  return join(dir, readdirSync(dir).find((f) => f.startsWith(`${id}-`) || f === `${id}.md`)!);
};
const corpusAt = (root: string) => readCorpus(root, ws(root).config.types, ws(root).config).corpus;
const base = (wt: string) => sh(wt, "merge-base", "HEAD", "main");
const BASIS = "\n## 方案依据\n\n沿用：无。新选择：引入 left-pad。最坏失败：上游撤包，构建失败。证据：npm 文档的 unpublish 限制。证伪：锁文件之外拿不到同一版本。\n";

describe("one-way-door classes (BR-2491)", () => {
  test("BR-2491: package manifests and migrations are touched by default, canon's own documents never, and a class set to [] is off", () => {
    const t = touchedClasses(["web/package.json", "db/migrations/001.sql", "canon/changes/C-1.md", "src/a.ts"], DEFAULT_DESIGN_SIGNALS);
    expect([...t.keys()]).toEqual(["persistent", "dependency"]);
    expect(t.get("dependency")).toEqual(["web/package.json"]);
    expect(touchedClasses(["web/package.json"], { ...DEFAULT_DESIGN_SIGNALS, dependency: [] }).size).toBe(0);
    expect([...touchedClasses(["game/src/save_game/store.gd"], { ...DEFAULT_DESIGN_SIGNALS, persistent: ["game/src/save_game/**"] }).keys()]).toEqual(["persistent"]);
  });

  test("BR-2491: a change touching a manifest without a 方案依据 section gets a note naming the class and its question; a basis silences it; the main checkout gets none", () => {
    const root = project();
    const s = startNew(root, "Add a dependency");
    writeFileSync(join(s.worktree, "package.json"), '{"dependencies":{"left-pad":"1.3.0"}}\n');
    const note = designBasisNote(s.worktree, corpusAt(s.worktree), base(s.worktree), DEFAULT_DESIGN_SIGNALS);
    expect(note).toContain("this work touches one-way-door paths (BR-2491, D-124)");
    expect(note).toContain(`add a ## 方案依据 section to canon/changes/${s.change}`);
    expect(note).toContain("dependency (package.json): why this dependency over building it or another one");
    writeFileSync(changeFile(s.worktree, s.change), readFileSync(changeFile(s.worktree, s.change), "utf8") + "\n## 方案依据\n\n<what it reuses>\n");
    expect(designBasisNote(s.worktree, corpusAt(s.worktree), base(s.worktree), DEFAULT_DESIGN_SIGNALS)).toContain("this work touches one-way-door paths"); // a placeholder is no basis
    writeFileSync(changeFile(s.worktree, s.change), readFileSync(changeFile(s.worktree, s.change), "utf8").replace("\n## 方案依据\n\n<what it reuses>\n", BASIS));
    expect(designBasisNote(s.worktree, corpusAt(s.worktree), base(s.worktree), DEFAULT_DESIGN_SIGNALS)).toBeUndefined();
    expect(designBasisNote(root, corpusAt(root), sh(root, "rev-parse", "HEAD"), DEFAULT_DESIGN_SIGNALS)).toBeUndefined();
  });

  test("BR-2491: design_signals with a class canon does not know, or a value that is not a list of globs, is a config error", () => {
    const root = project();
    for (const bad of ["design_signals: {saves: [\"a/**\"]}", "design_signals: {persistent: \"a/**\"}"]) {
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\n${bad}\n`);
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../../invocation/main.ts"), "check"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("design_signals");
    }
  });
});

describe("why a decision revises another (BR-2492)", () => {
  const decision = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: proposed\n${extra}---\n\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;

  test("BR-2492: a decision this work adds that amends or supersedes another existing decision needs a known revised_because; a reference to itself or to nothing is not asked for one; one already on main is not checked", () => {
    const root = project();
    const s = startNew(root, "Revise");
    const dir = join(s.worktree, "canon/decisions");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "D-1.md"), decision("D-1", ""));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "first decision");
    const onlyD1 = sh(s.worktree, "rev-parse", "HEAD");
    writeFileSync(join(dir, "D-2.md"), decision("D-2", "amends:\n  - D-1\n"));
    writeFileSync(join(dir, "D-3.md"), decision("D-3", "supersedes: D-1\nrevised_because: typo\n"));
    writeFileSync(join(dir, "D-4.md"), decision("D-4", "amends:\n  - D-1\nrevised_because: premise\n"));
    writeFileSync(join(dir, "D-5.md"), decision("D-5", "amends:\n  - D-5\n  - D-99\n")); // itself and a missing one: their own findings, no reason asked
    const found = revisionReasonFindings(s.worktree, corpusAt(s.worktree), onlyD1);
    expect(found.map((f) => f.path)).toEqual(["canon/decisions/D-2.md", "canon/decisions/D-3.md"]);
    expect(found[0]!.message).toContain("names no `revised_because`");
    expect(found[1]!.message).toContain("names an unknown `revised_because` (typo)");
    expect(found[0]!.message).toContain("premise, requirement, external, experience, implementation");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "revisions");
    expect(revisionReasonFindings(s.worktree, corpusAt(s.worktree), sh(s.worktree, "rev-parse", "HEAD"))).toEqual([]); // already there before this work
  });
});

describe("the review's note on a design basis (BR-2493)", () => {
  test("BR-2493: the rule review prompt asks for a note, never a block, on a reuse hiding a new choice, a missing worst failure or falsifier, and evidence that answers nothing", () => {
    const root = project();
    const prompt = reviewPrompt(root, corpusAt(root), []);
    expect(prompt).toContain("When the change shown below has a section 方案依据 (its design basis), add a note (never block)");
    expect(prompt).toContain("a new choice hidden behind the reuse");
    expect(prompt).toContain("no result that would prove the choice wrong");
  });

  test("BR-2493: the change's 方案依据 itself is in the prompt, also when the change file is not among the changed documents; a placeholder basis is not", () => {
    const root = project();
    const s = startNew(root, "Basis shown");
    const file = changeFile(s.worktree, s.change);
    writeFileSync(file, readFileSync(file, "utf8") + "\n## 方案依据\n\n<what it reuses>\n");
    const placeholder = corpusAt(s.worktree).docs.find((d) => d.id === s.change)!;
    expect(reviewPrompt(s.worktree, corpusAt(s.worktree), [], { change: placeholder })).not.toContain(`# 方案依据 of ${s.change}`);
    writeFileSync(file, readFileSync(file, "utf8").replace("\n## 方案依据\n\n<what it reuses>\n", BASIS.replace("证伪：", "证伪：SENTINEL-basis-7f3 ")));
    const change = corpusAt(s.worktree).docs.find((d) => d.id === s.change)!;
    const prompt = reviewPrompt(s.worktree, corpusAt(s.worktree), [], { change });
    expect(prompt).toContain(`# 方案依据 of ${s.change}`);
    expect(prompt).toContain("SENTINEL-basis-7f3");
  });
});

describe("design basis on the record (BR-2494)", () => {
  test("BR-2494: a landing that touched a class records it with whether the change had a basis, and canon stats counts per class; a landing that touched none records nothing", async () => {
    const root = project();
    const plain = startNew(root, "Plain");
    writeFileSync(join(plain.worktree, "app.txt"), "changed\n");
    sh(plain.worktree, "commit", "-qam", "plain");
    expect((await land(ws(plain.worktree), FAST, quiet)).kind).toBe("landed");
    const withBasis = startNew(root, "With basis");
    writeFileSync(join(withBasis.worktree, "package.json"), '{"dependencies":{"a":"1"}}\n');
    writeFileSync(changeFile(withBasis.worktree, withBasis.change), readFileSync(changeFile(withBasis.worktree, withBasis.change), "utf8") + BASIS);
    sh(withBasis.worktree, "add", "-A");
    sh(withBasis.worktree, "commit", "-qm", "dependency with basis");
    expect((await land(ws(withBasis.worktree), FAST, quiet)).kind).toBe("landed");
    const without = startNew(root, "Without basis");
    writeFileSync(join(without.worktree, "package.json"), '{"dependencies":{"a":"2"}}\n');
    sh(without.worktree, "commit", "-qam", "dependency without basis");
    expect((await land(ws(without.worktree), FAST, quiet)).kind).toBe("landed");
    const db = ws(root).db;
    const rows = db.db.query<{ subject: string; basis: number }, []>("SELECT subject, json_extract(detail, '$.basis') AS basis FROM events WHERE kind = 'design.basis' ORDER BY id").all();
    expect(rows).toEqual([{ subject: withBasis.change, basis: 1 }, { subject: without.change, basis: 0 }]);
    const s = designStats(db, root, corpusAt(root), "main", 0, Number.MAX_SAFE_INTEGER);
    expect(s.classes.dependency).toEqual({ landings: 2, withBasis: 1 });
    expect(renderDesignStats(s)).toContain("dependency: 2 landing(s), 1 with a basis");
  });

  test("BR-2494: canon stats counts revising decisions by revised_because and how many came within 7 days of the decision they revise", () => {
    const root = project();
    Bun.spawnSync(["mkdir", "-p", join(root, "canon/decisions")]);
    const d = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: accepted\n${extra}---\n\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    writeFileSync(join(root, "canon/decisions/D-1.md"), d("D-1", ""));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "d1");
    writeFileSync(join(root, "canon/decisions/D-2.md"), d("D-2", "amends:\n  - D-1\nrevised_because: premise\n"));
    writeFileSync(join(root, "canon/decisions/D-3.md"), d("D-3", "amends:\n  - D-1\nrevised_because: requirement\n"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "revisions");
    const s = designStats(ws(root).db, root, corpusAt(root), "main", 0, Number.MAX_SAFE_INTEGER);
    expect(s.revisions).toEqual([{ reason: "premise", count: 1, within7Days: 1 }, { reason: "requirement", count: 1, within7Days: 1 }]);
    expect(renderDesignStats(s)).toContain("decisions revised, by revised_because: premise 1 (1 within 7 days), requirement 1 (1 within 7 days)");
  });

  test("BR-2494: the 7 days run from the revised decision's first commit under its id: exactly 7 days is within, a second more is not, a copy of the old file under a new id is not dated as the old one, a re-add of the same id keeps the first date, and one dated before the decision it revises is not within", () => {
    const root = project();
    const dir = join(root, "canon/decisions");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const d = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: accepted\n${extra}---\n\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    const T0 = 1_768_000_000;
    const commitAt = (t: number, msg: string) => {
      sh(root, "add", "-A");
      const env = { ...process.env, GIT_AUTHOR_DATE: `@${t} +0000`, GIT_COMMITTER_DATE: `@${t} +0000` };
      expect(Bun.spawnSync(["git", "commit", "-qm", msg], { cwd: root, env }).exitCode).toBe(0);
    };
    writeFileSync(join(dir, "D-1.md"), d("D-1", ""));
    commitAt(T0, "d1");
    writeFileSync(join(dir, "D-2.md"), d("D-2", "amends:\n  - D-1\nrevised_because: premise\n"));
    commitAt(T0 + 7 * 86_400, "d2 at exactly 7 days");
    writeFileSync(join(dir, "D-3.md"), d("D-3", "amends:\n  - D-1\nrevised_because: premise\n"));
    commitAt(T0 + 7 * 86_400 + 1, "d3 a second later");
    sh(root, "rm", "-q", "canon/decisions/D-1.md");
    commitAt(T0 + 20 * 86_400, "drop d1");
    writeFileSync(join(dir, "D-1.md"), d("D-1", ""));
    commitAt(T0 + 30 * 86_400, "d1 again");
    writeFileSync(join(dir, "D-4.md"), d("D-4", "amends:\n  - D-1\nrevised_because: external\n"));
    commitAt(T0 - 86_400, "d4 with a clock set back a day");
    const s = designStats(ws(root).db, root, corpusAt(root), "main", 0, Number.MAX_SAFE_INTEGER);
    expect(s.revisions).toEqual([{ reason: "premise", count: 2, within7Days: 1 }, { reason: "external", count: 1, within7Days: 0 }]);
  });

  test("BR-2494: canon stats reads main as committed: a revising decision only on a work branch, uncommitted, is not counted", () => {
    const root = project();
    Bun.spawnSync(["mkdir", "-p", join(root, "canon/decisions")]);
    const d = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: accepted\n${extra}---\n\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    writeFileSync(join(root, "canon/decisions/D-1.md"), d("D-1", ""));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "d1");
    const s = startNew(root, "Propose a revision");
    Bun.spawnSync(["mkdir", "-p", join(s.worktree, "canon/decisions")]);
    writeFileSync(join(s.worktree, "canon/decisions/D-2.md"), d("D-2", "amends:\n  - D-1\nrevised_because: premise\n").replace("status: accepted", "status: proposed"));
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../../invocation/main.ts"), "stats"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).not.toContain("premise");
  });
});
