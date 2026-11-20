import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";
import { afterLandLines } from "./related.ts";
import { relatedStandings } from "../../knowledge/quality/related.ts";
import { mainCorpus } from "../session/session.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default (as in reminders.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

function cli(cwd: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, CANON_MACHINE: "normal,1,8", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const standard = (n: number, covers: string, judge = "agent") => `---\nid: Q-${n}\ntitle: 标准${n}\naspect: 战斗手感\njudge: ${judge}\ncovers: ${covers}\n---\n\n## 门槛\n\n首领场地约 640×400。\n\n## 来源\n\n- 暖雪实测\n`;

function fixture(files: Record<string, string>, config = ""): string {
  const root = project();
  roots.push(root);
  if (config) appendFileSync(join(root, "canon/config.yaml"), config);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  const all: Record<string, string> = { "canon/quality/README.md": "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n", "src/a.txt": "a\n", "docs/d.txt": "d\n", ...files };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

let seq = 0;
function land(root: string, file: string): string {
  const base = sh(root, "rev-parse", "HEAD");
  writeFileSync(join(root, file), `change ${++seq}\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", `C-${200 + seq}: edit ${file}`);
  const sha = sh(root, "rev-parse", "HEAD");
  ws(root, "agent:x").db.event("agent:x", "land.ok", `C-${200 + seq}`, { sha, base });
  return sha;
}

const verdict = (root: string, id: string, result: string) => expect(cli(root, "agent:j", "quality", "verdict", id, "--result", result, "--evidence", "e").code).toBe(0);
const judge = (root: string, actor = "agent:s1") => (JSON.parse(cli(root, actor, "work", "due", "--json").out) as { judge: { key: string; kind: string; summary: string; next: string }[] }).judge.filter((i) => i.key.startsWith("quality:"));

describe("quality standards in the agenda and at start and landing", () => {
  test("BR-2591: a failed or stale standard is one judge item; unproven and proven are not; handled outcomes apply; a worker has none", () => {
    const root = fixture({ "canon/quality/Q-1.md": standard(1, "[src]"), "canon/quality/Q-2.md": standard(2, "[src]"), "canon/quality/Q-3.md": standard(3, "[src]"), "canon/quality/Q-4.md": standard(4, "[src]") }, "quality_stale_agent: 1\n");
    expect(judge(root)).toEqual([]);
    verdict(root, "Q-1", "fail");
    verdict(root, "Q-2", "pass");
    verdict(root, "Q-3", "pass");
    land(root, "src/a.txt");
    // Q-1 failed, Q-2 and Q-3 stale (one landing, limit 1), Q-4 never judged
    const items = judge(root);
    expect(items.map((i) => [i.key, i.kind])).toEqual([["quality:Q-1", "quality-failed"], ["quality:Q-2", "quality-stale"], ["quality:Q-3", "quality-stale"]]);
    expect(items[0]!.summary).toContain("不通过");
    expect(items[1]!.summary).toContain("limit 1");
    expect(items[1]!.next).toContain("canon quality verdict Q-2");
    // a not-doing outcome keeps it out
    expect(cli(root, "agent:s1", "work", "handled", "quality:Q-2", "--not-doing", "later").code).toBe(0);
    expect(judge(root).map((i) => i.key)).toEqual(["quality:Q-1", "quality:Q-3"]);
    // a new pass makes Q-3 proven again
    verdict(root, "Q-3", "pass");
    expect(judge(root).map((i) => i.key)).toEqual(["quality:Q-1"]);
    // a worker sees none of it
    expect(judge(root, "agent:s1:w1")).toEqual([]);
    // landings outside the covered paths do not make it stale
    verdict(root, "Q-1", "pass");
    land(root, "docs/d.txt");
    expect(judge(root)).toEqual([]);
  });

  test("BR-2592: the first start of a change lists the related standards with their state, a later start does not; one covering . is related to every change", () => {
    const root = fixture({ "canon/quality/Q-1.md": standard(1, "[.]"), "canon/quality/Q-2.md": standard(2, "[src]") });
    verdict(root, "Q-1", "pass");
    const first = cli(root, "agent:s1", "work", "start", "--title", "A change");
    expect(first.code).toBe(0);
    const change = /C-\d+/.exec(first.out)![0];
    const lines = first.out.split("\n").filter((l) => l.startsWith("quality:"));
    // Q-2 covers src only and the change lists no rule there
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Q-1 [战斗手感] 已证明（agent，");
    expect(lines[0]).toContain(`在 ${change} 变更文件的“陷阱和假设”里写这条标准怎么处理`);
    expect(cli(root, "agent:s1", "work", "start", change).out).not.toContain("quality:");
  });

  test("BR-2592: a standard covering a domain is related to a change with a rule in that domain or below it, not to one in another domain", () => {
    const root = fixture({ "canon/quality/Q-1.md": standard(1, "[work]") });
    const w = ws(root, "agent:s1");
    const corpus = mainCorpus(w);
    if (!corpus.ok) throw new Error(corpus.error.message);
    const ids = (domains: string[]) => { const r = relatedStandings(w, corpus.value, { domains: new Set(domains) }); if (!r.ok) throw new Error(r.message); return r.standings.map((s) => s.q.id); };
    expect(ids(["work/land"])).toEqual(["Q-1"]);
    expect(ids(["work"])).toEqual(["Q-1"]);
    expect(ids(["knowledge/quality"])).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  test("BR-2592: after a landing, the standards whose paths it changed are listed whatever their state, and none for a landing that touched other files", () => {
    const root = fixture({ "canon/quality/Q-1.md": standard(1, "[src]"), "canon/quality/Q-2.md": standard(2, "[docs]") });
    const w = ws(root, "agent:s1");
    const onSrc = land(root, "src/a.txt");
    const lines = afterLandLines(w, { sha: onSrc, change: null });
    expect(lines.filter((l) => l.startsWith("quality:"))).toEqual(["quality: Q-1 [战斗手感] 没判过"]);
    const elsewhere = land(root, "app.txt");
    expect(afterLandLines(w, { sha: elsewhere, change: null }).some((l) => l.startsWith("quality:"))).toBe(false);
  });
});
