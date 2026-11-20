import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default (as in quality.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function canon(cwd: string, actor: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
}

const standard = (n: number, judge: string, covers: string, status = "") => `---\nid: Q-${n}\ntitle: 标准${n}\naspect: 战斗手感\njudge: ${judge}\ncovers: ${covers}\n${status}---\n\n## 门槛\n\n首领场地约 640×400。\n\n## 来源\n\n- 暖雪实测\n`;

/** A project with the aspect list, Q-1 judged by an agent covering src, Q-2 judged by the owner covering the whole repository. */
function fixture(config = ""): string {
  const root = project();
  roots.push(root);
  if (config) appendFileSync(join(root, "canon/config.yaml"), config);
  write(root, {
    "canon/quality/README.md": "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n",
    "canon/quality/Q-1.md": standard(1, "agent", "[src]"),
    "canon/quality/Q-2.md": standard(2, "owner", "[.]"),
    "src/a.txt": "a\n",
    "docs/d.txt": "d\n",
  });
  return root;
}

let seq = 0;
/** A landing of `actor`: a commit changing `file`, and the `land.ok` event the landing writes. */
function land(root: string, actor: string, file: string): string {
  const base = sh(root, "rev-parse", "HEAD");
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), `change ${++seq}\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", `C-${100 + seq}: edit ${file}`);
  const sha = sh(root, "rev-parse", "HEAD");
  ws(root, actor).db.event(actor, "land.ok", `C-${100 + seq}`, { sha, base });
  return sha;
}

const events = (root: string) => ws(root).db.db.query<{ subject: string; actor: string; detail: string }, []>("SELECT subject, actor, detail FROM events WHERE kind = 'quality.verdict' ORDER BY id").all().map((e) => ({ ...e, detail: JSON.parse(e.detail) as Record<string, unknown> }));
const verdict = (root: string, actor: string, ...args: string[]) => canon(root, actor, "quality", "verdict", ...args);
/** An answered question as the owner at a terminal gave it (the answer is the owner's, BR-2587). */
function answered(root: string, text: string, by = "human:o", relayed: string | null = null, witness: string | null = null): number {
  const w = ws(root);
  const r = w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, answer, answered_by, relayed, witness, asked_at, answered_at) VALUES (NULL, 'agent:a', ?, '[]', 0, 'pass', ?, ?, ?, ?, ?)").run(text, by, relayed, witness, new Date().toISOString(), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

describe("quality verdicts", () => {
  test("BR-2586: canon quality verdict records a quality.verdict event with commit, result, by, evidence and self, writes no file, and refuses what is not recorded", () => {
    const root = fixture();
    const head = sh(root, "rev-parse", "HEAD");
    const ok = verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "evidence/q1.md");
    expect(ok.code).toBe(0);
    expect(ok.out.trim()).toBe(`recorded verdict Q-1 pass at ${head.slice(0, 9)} by agent`);
    expect(events(root)).toEqual([{ subject: "Q-1", actor: "agent:j", detail: { commit: head, result: "pass", by: "agent", evidence: "evidence/q1.md", self: false } }]);
    expect(sh(root, "status", "--porcelain")).toBe("");
    // an explicit commit
    const first = sh(root, "rev-list", "--max-parents=0", "HEAD");
    expect(verdict(root, "agent:j", "Q-1", "--result", "fail", "--evidence", "e", "--commit", first).code).toBe(0);
    expect(events(root)[1]!.detail["commit"]).toBe(first);
    const before = events(root).length;
    expect(verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "e", "--by", "owner").code).toBe(2);
    expect(verdict(root, "agent:j", "Q-9", "--result", "pass", "--evidence", "e").code).toBe(3);
    expect(verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "e", "--commit", "deadbeef").code).toBe(3);
    expect(verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "").code).toBe(2);
    expect(verdict(root, "agent:j", "Q-1", "--result", "maybe", "--evidence", "e").code).toBe(2);
    write(root, { "canon/quality/Q-3.md": standard(3, "agent", "[src]", "status: retired\nretired_reason: 不用了\n") });
    expect(verdict(root, "agent:j", "Q-3", "--result", "pass", "--evidence", "e").code).toBe(2);
    expect(events(root).length).toBe(before);
  });

  test("BR-2587: an owner verdict needs an answered canon human question that names the standard, is unused and is the owner's; the owner's words are recorded", () => {
    const root = fixture();
    const asked = answered(root, "Q-2: 首领场地约 640×400，通过吗？");
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--by", "owner").code).toBe(2);
    const ok = verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(asked));
    expect(ok.code).toBe(0);
    expect(events(root)[0]!.detail).toMatchObject({ by: "owner", self: false, question: asked, owner_words: "pass" });
    // the same question again
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(asked)).code).toBe(1);
    // a question about Q-20 is not about Q-2
    const other = answered(root, "Q-20: 通过吗？");
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(other)).code).toBe(1);
    // unanswered
    const open = ws(root).db.db.query("INSERT INTO questions(subject, asked_by, question, options, multi, asked_at) VALUES (NULL, 'agent:a', 'Q-2: 通过吗？', '[]', 0, ?)").run(new Date().toISOString());
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(open.lastInsertRowid)).code).toBe(1);
    // a relay whose words do not match Claude Code's record is an agent's word
    const relayed = answered(root, "Q-2: 通过吗？", "agent:a", "pass", "differs");
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(relayed)).code).toBe(1);
    // a relay that matches counts, with its words
    const matched = answered(root, "Q-2: 通过吗？", "agent:a", "通过", "match");
    expect(verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(matched)).code).toBe(0);
    expect(events(root).at(-1)!.detail["owner_words"]).toBe("通过");
    expect(verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "e", "--question", "1").code).toBe(2);
  });

  test("BR-2588: an agent verdict is self-judged when its actor landed a change on the covered paths between the previous verdict's commit and the judged commit", () => {
    const root = fixture();
    land(root, "agent:a", "src/a.txt");
    expect(verdict(root, "agent:a", "Q-1", "--result", "pass", "--evidence", "e").out).toContain("(self-judged)");
    expect(events(root)[0]!.detail["self"]).toBe(true);
    expect(verdict(root, "agent:b", "Q-1", "--result", "pass", "--evidence", "e").code).toBe(0);
    expect(events(root)[1]!.detail["self"]).toBe(false);
    // the landing is already inside the previous verdict's commit: no longer a reason
    expect(verdict(root, "agent:a", "Q-1", "--result", "pass", "--evidence", "e").code).toBe(0);
    expect(events(root)[2]!.detail["self"]).toBe(false);
    // a landing outside the covered paths
    land(root, "agent:c", "docs/d.txt");
    verdict(root, "agent:c", "Q-1", "--result", "pass", "--evidence", "e");
    expect(events(root)[3]!.detail["self"]).toBe(false);
    // an owner verdict is never self-judged
    land(root, "agent:a", "src/a.txt");
    const q = answered(root, "Q-2: 通过吗？");
    verdict(root, "agent:a", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(q));
    expect(events(root)[4]!.detail["self"]).toBe(false);
  });

  test("BR-2589: the state is proven, failed, stale or unproven from the latest verdict and the landings after its commit; agent and owner thresholds are separate and configurable", () => {
    const root = fixture("quality_stale_agent: 3\nquality_stale_owner: 5\n");
    const state = (id: string) => (JSON.parse(canon(root, "agent:a", "quality", "list", "--json").out) as { id: string; verdict: { state: string; landings: number; threshold: number } | null }[]).find((q) => q.id === id)!.verdict;
    expect(state("Q-1")).toBeNull();
    expect(canon(root, "agent:a", "quality", "list").out).toContain("判定状态 没判过");
    verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "e");
    expect(state("Q-1")).toMatchObject({ state: "proven", landings: 0, threshold: 3 });
    land(root, "agent:x", "src/a.txt");
    land(root, "agent:x", "docs/d.txt");
    land(root, "agent:x", "src/a.txt");
    expect(state("Q-1")).toMatchObject({ state: "proven", landings: 2 });
    land(root, "agent:x", "src/a.txt");
    expect(state("Q-1")).toMatchObject({ state: "stale", landings: 3, threshold: 3 });
    expect(canon(root, "agent:a", "quality", "list").out).toContain("判定状态 过期（agent，");
    expect(canon(root, "agent:a", "quality", "list").out).toContain("（之后合入 3/3）");
    // a failed verdict stays failed whatever lands after it, and a later pass replaces it
    verdict(root, "agent:j", "Q-1", "--result", "fail", "--evidence", "e");
    expect(state("Q-1")).toMatchObject({ state: "failed" });
    verdict(root, "agent:j", "Q-1", "--result", "pass", "--evidence", "e");
    expect(state("Q-1")).toMatchObject({ state: "proven", landings: 0 });
    // the owner's threshold is its own: 4 landings on the whole repository are not yet 5
    const q = answered(root, "Q-2: 通过吗？");
    verdict(root, "agent:j", "Q-2", "--result", "pass", "--evidence", "e", "--question", String(q));
    for (let i = 0; i < 4; i++) land(root, "agent:x", "docs/d.txt");
    expect(state("Q-2")).toMatchObject({ state: "proven", landings: 4, threshold: 5 });
    land(root, "agent:x", "docs/d.txt");
    expect(state("Q-2")).toMatchObject({ state: "stale", landings: 5, threshold: 5 });
    // a verdict whose build commit is gone is stale
    ws(root).db.event("agent:j", "quality.verdict", "Q-1", { commit: "0".repeat(40), result: "pass", by: "agent", evidence: "e", self: false });
    expect(state("Q-1")).toMatchObject({ state: "stale" });
  });

  test("BR-2589: a threshold in canon/config.yaml that is not a whole number of at least 1 is a configuration error, exit 2", () => {
    const root = fixture("quality_stale_agent: 0\n");
    const r = canon(root, "agent:a", "quality", "list");
    expect(r.code).toBe(2);
    expect(r.err).toContain("quality_stale_agent");
  });

  test("BR-2590: list, status and overview show the state, mark self-judged verdicts and count them", () => {
    const root = fixture();
    land(root, "agent:a", "src/a.txt");
    verdict(root, "agent:a", "Q-1", "--result", "pass", "--evidence", "e");
    const list = canon(root, "agent:a", "quality", "list").out.split("\n");
    expect(list[0]).toMatch(/^Q-1\s+draft\s+标准1\s+方面 战斗手感\s+判定 agent\s+\(负责人未确认\)\s+判定状态 已证明（agent，自评，\d{4}-\d{2}-\d{2}，[0-9a-f]{7}）$/);
    expect(list[1]).toMatch(/判定状态 没判过$/);
    const status = canon(root, "agent:a", "quality", "status");
    expect(status.out).toContain("判定状态 已证明（agent，自评，");
    expect(JSON.parse(canon(root, "agent:a", "quality", "status", "--json").out).aspects[0].standards[0].verdict.self).toBe(true);
    const overview = canon(root, "agent:a", "overview");
    expect(overview.out).toContain("质量判定：不通过 0，过期 0，没判过 1，已证明 1；自评 1 条（Q-1）");
    expect(JSON.parse(canon(root, "agent:a", "overview", "--json").out).quality.verdicts).toEqual({ failed: 0, stale: 0, unproven: 1, proven: 1, self: ["Q-1"] });
    // no standard in force: no verdict line
    const bare = project();
    roots.push(bare);
    expect(canon(bare, "agent:a", "overview").out).not.toContain("质量判定");
  });
});
