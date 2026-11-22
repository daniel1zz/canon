import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../testkit.ts";

// reason: each case spawns canon; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const id = (p: string, n: number) => [p, n].join("-");
function canon(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_MACHINE: "normal,1,8" } });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
function put(root: string, path: string, text: string) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
const decision = (n: number, status: string, body = "d") => `---\nid: ${id("D", n)}\ntitle: 决定${n}\nstatus: ${status}\namends: "none: t"\n---\n## 背景\n\nb\n\n## 方案\n\n- 采用 x\n- 否决 y\n\n## 决定\n\n${body}\n\n## 后果\n\nc\n`;
const change = (n: number, status: string, body = "x") => `---\nid: ${id("C", n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\nowner_gate: "none: t"\nadvances: "none: t"\n---\n\n## 为什么\n\n${body}\n\n## 要改什么\n\nx\n`;

function fixture(): string {
  const root = project(); roots.push(root);
  put(root, "canon/product.md", "# Product\n\nShared work.\n");
  put(root, "canon/rules/task/README.md", "---\ncode: [src]\n---\n# task\n\nTasks.\n\n## 业务\n\n- **派活**：怎么派\n");
  put(root, `canon/rules/task/${id("BR", 5)}.md`, `---\nid: ${id("BR", 5)}\ntitle: 规划中的规则\nstatus: planned\nbusiness: 派活\n---\n\n## 规则\n\nS.\n\n## 例子\n\n- a → b\n`);
  put(root, `canon/rules/task/${id("BR", 6)}.md`, `---\nid: ${id("BR", 6)}\ntitle: 退役的规则写到 ${id("D", 10)}\nstatus: retired\nbusiness: 派活\n---\n\n## 规则\n\n照 ${id("D", 10)}。\n\n## 例子\n\n- a → b\n`);
  put(root, `canon/decisions/${id("D", 7)}.md`, decision(7, "accepted"));
  put(root, `canon/decisions/${id("D", 8)}.md`, decision(8, "accepted", `修订 ${id("D", 7)} 的一部分`));
  put(root, `canon/decisions/${id("D", 10)}.md`, decision(10, "accepted"));
  put(root, `canon/decisions/${id("D", 11)}.md`, decision(11, "proposed"));
  put(root, `canon/changes/${id("C", 9)}.md`, change(9, "open", `按 ${id("D", 8)} 做`));
  put(root, `canon/changes/${id("C", 4)}.md`, change(4, "done"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  const w = ws(root);
  try {
    const now = new Date().toISOString();
    w.db.db.query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at, tier) VALUES ('f1', 'untestable', ?, ?, '没有测试点名', ?, 1, 'abc', ?, 'A')").run(JSON.stringify([id("BR", 5)]), JSON.stringify([id("BR", 5)]), id("C", 9), now);
    const ask = w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at, answer, answered_by, answered_at) VALUES (?, 'agent:a', ?, '[]', ?, ?, ?, ?)");
    ask.run(id("C", 9), "要不要做?", now, null, null, null);
    ask.run(id("C", 9), "答过的问题?", now, "要", "human:o", now);
    w.db.db.query("INSERT INTO questions(subject, asked_by, question, options, asked_at, withdrawn) VALUES (?, 'agent:a', '撤回的问题?', '[]', ?, '不需要了')").run(id("C", 9), now);
  } finally { w.db.close(); }
  return root;
}

test("BR-2629: canon work remaining lists open changes, rules not passed, open findings, unanswered questions and accepted decisions nothing names, each section counted; closed, retired, proposed, answered and withdrawn items are left out; the last line points to the project's issue tool; --json has changes, rules, findings, questions and decisions", () => {
  const root = fixture();
  const r = canon(root, "work", "remaining");
  expect(r.code).toBe(0);
  const lines = r.out.trim().split("\n");
  const section = (head: string) => { const at = lines.findIndex((l) => l.startsWith(`## ${head}`)); const next = lines.findIndex((l, i) => i > at && (l.startsWith("## ") || l === "")); return { head: lines[at], items: lines.slice(at + 1, next === -1 ? undefined : next) }; };
  const changes = section("没关闭的变更");
  expect(changes.head).toBe("## 没关闭的变更（1）");
  expect(changes.items).toEqual([expect.stringMatching(new RegExp(`^${id("C", 9)} 变更9  `))]);
  expect(section("没通过的规则").head).toBe("## 没通过的规则（全部，不只当前版本）（1）");
  expect(section("没通过的规则").items).toEqual([`规划中 1：${id("BR", 5)}`]);
  expect(section("没关的评审意见").items).toEqual([expect.stringMatching(new RegExp(`^#\\d+ \\[A\\] \\[untestable\\] ${id("BR", 5)}: 没有测试点名$`))]);
  expect(section("待回答的问题").items).toEqual([expect.stringMatching(new RegExp(`^#\\d+ \\[${id("C", 9)}\\] 要不要做\\?$`))]);
  const decisions = section("没有规则或变更引用的已接受决定");
  // D-7 is named only by another decision, D-10 only by a retired rule; D-8 by an open change; D-11 is proposed
  expect(decisions.head).toBe("## 没有规则或变更引用的已接受决定（2）");
  expect(decisions.items).toEqual([`${id("D", 7)} 决定7`, `${id("D", 10)} 决定10`]);
  expect(lines.at(-1)).toBe("项目的 issue 不在 canon 里：用项目自己的 issue 工具查。");
  const json = JSON.parse(canon(root, "work", "remaining", "--json").out) as { changes: { id: string }[]; rules: { planned: string[]; waiting: string[]; rerun: string[] }; findings: { tier: string }[]; questions: { question: string }[]; decisions: { id: string }[] };
  expect(json.changes.map((c) => c.id)).toEqual([id("C", 9)]);
  expect(json.rules).toEqual({ planned: [id("BR", 5)], waiting: [], rerun: [] });
  expect(json.findings.map((f) => f.tier)).toEqual(["A"]);
  expect(json.questions.map((q) => q.question)).toEqual(["要不要做?"]);
  expect(json.decisions.map((d) => d.id)).toEqual([id("D", 7), id("D", 10)]);
});

test("BR-2629: with nothing unfinished every section says (none) and the exit code is 0", () => {
  const root = project(); roots.push(root);
  const r = canon(root, "work", "remaining");
  expect(r.code).toBe(0);
  expect(r.out.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.replace(/（.*/, ""))).toEqual(["## 没关闭的变更", "## 没通过的规则", "## 没关的评审意见", "## 待回答的问题", "## 没有规则或变更引用的已接受决定", "## 决定里没写到规则或变更的条目"]);
  expect(r.out.split("\n").filter((l) => l === "(none)").length).toBe(6);
});

test("BR-2629: each 决定 item of a recently added accepted decision that names no rule or change is listed; an item naming one is not; a decision added to main 40 days ago only with --all; past 30 lines the rest is counted; --json has every item and allItems", () => {
  const root = project(); roots.push(root);
  put(root, `canon/decisions/${id("D", 3)}.md`, decision(3, "accepted", "- 很久以前的一条"));
  // reason: committed 40 days ago, so its items are listed only with --all
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  sh(root, "add", "-A");
  Bun.spawnSync(["git", "commit", "-qm", "old decision"], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old } });
  put(root, `canon/decisions/${id("D", 7)}.md`, decision(7, "accepted", `- ${id("BR", 5)}：按这个做\n- 另外要做 Y，\n  续行也算这一条\n\n第二段没有列表`));
  put(root, `canon/decisions/${id("D", 8)}.md`, decision(8, "accepted", Array.from({ length: 31 }, (_, i) => `- 第 ${i + 1} 条`).join("\n")));
  put(root, `canon/decisions/${id("D", 9)}.md`, decision(9, "proposed", "- 没接受的"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "recent decisions");
  const items = (r: string) => { const ls = r.split("\n"); const at = ls.findIndex((l) => l.startsWith("## 决定里没写到")); return { head: ls[at]!, lines: ls.slice(at + 1, ls.indexOf("", at + 1)) }; };
  const recent = items(canon(root, "work", "remaining").out);
  expect(recent.head).toBe("## 决定里没写到规则或变更的条目（最近 30 天加入的已接受决定，--all 看全部）（33）");
  expect(recent.lines.slice(0, 2)).toEqual([`${id("D", 7)}：- 另外要做 Y， 续行也算这一条`, `${id("D", 7)}：第二段没有列表`]);
  expect(recent.lines.some((l) => l.includes("按这个做") || l.includes("很久以前") || l.includes("没接受"))).toBe(false);
  expect(recent.lines.length).toBe(31);
  expect(recent.lines.at(-1)).toBe("… 还有 3 条（canon work remaining --json）");
  const all = canon(root, "work", "remaining", "--all", "--json");
  const json = JSON.parse(all.out) as { items: { id: string; item: string }[]; allItems: boolean };
  expect(json.allItems).toBe(true);
  expect(json.items.length).toBe(34);
  expect(json.items[0]).toEqual({ id: id("D", 3), item: "- 很久以前的一条" });
  expect(items(canon(root, "work", "remaining", "--all").out).head).toBe("## 决定里没写到规则或变更的条目（全部已接受的决定）（34）");
});
