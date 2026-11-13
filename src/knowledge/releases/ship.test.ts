import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_COMMAND } from "../../install/hook.ts";
import { land } from "../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { behaviourHash } from "../documents/behaviour.ts";
import { parseDocFile } from "../documents/docfile.ts";

// reason: a ship spawns canon, opens a change and lands it; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const BR = (n: number) => id("BR", n);
const C = (n: number) => id("C", n);
const SESSION = "session-ship";

function canon(cwd: string, actor: string, args: string[], opts: { stdin?: string; tty?: boolean } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor, CLAUDE_CODE_SESSION_ID: SESSION };
  delete env["CLAUDECODE"]; // reason: inside Claude Code a human: CANON_ACTOR is refused (BR-2023)
  const cmd = ["bun", MAIN, ...args];
  const argv = !opts.tty ? cmd : process.platform === "darwin" ? ["script", "-q", "/dev/null", ...cmd] : ["script", "-qec", cmd.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const agent = (cwd: string, ...args: string[]) => canon(cwd, "agent:test", args);

const SECTIONS = ["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"];
const releaseText = (n: number, front: string) => `---\nid: ${R(n)}\ntitle: 第${n}版\n${front}---\n\n${SECTIONS.map((s) => `## ${s}\n\n${s}的内容\n`).join("\n")}`;
const ruleText = (n: number, front: string, status = "active") => `---\nid: ${BR(n)}\ntitle: 规则${n}\nstatus: ${status}\nuntested: fixture\n${front}---\n## 规则\n\n规则${n}的行为。\n\n## 例子\n\n- 输入 → 结果\n`;
const hashOf = (text: string) => behaviourHash((parseDocFile(text, "x") as { ok: true; value: { body: string } }).value.body);

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, "..").toString(), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/**
 * A repository where R-1 is active and its rules BR-1 and BR-2 are passed (C-7); with `extra` rules written on top.
 * The question tool's record hook is installed (the relay check of BR-2276 needs it).
 */
function fixture(extra: Record<string, string> = {}, tagged = [1, 2]): string {
  const root = project();
  const rules = Object.fromEntries(tagged.map((n) => [n, ruleText(n, `release: ${R(1)}\n`)]));
  write(root, {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "src/billing/.keep": "",
    ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: RECORD_COMMAND }] }] } }),
    [`canon/releases/${R(1)}.md`]: releaseText(1, "status: active\n"),
    ...Object.fromEntries(Object.entries(rules).map(([n, t]) => [`canon/rules/billing/${BR(Number(n))}.md`, t])),
    [`canon/changes/${C(7)}.md`]: `---\nid: ${C(7)}\ntitle: 做了\nstatus: done\nrules: [${tagged.map(BR).join(", ")}]\npasses:\n${tagged.map((n) => `  ${BR(n)}: "${hashOf(rules[n]!)} acceptance"`).join("\n")}\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`,
    ...extra,
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  acceptNow(root);
  return root;
}

/** Marks main's tip accepted the way canon accept records it (BR-2462), so the ship under test has an accepted commit (D-89). */
function acceptNow(root: string): string {
  const sha = sh(root, "rev-parse", "main").trim();
  sh(root, "update-ref", "refs/canon/accepted", sha);
  ws(root).db.event("human:owner", "accept.ok", null, { commit: sha });
  return sha;
}

const question = (n: number) => `ship ${R(n)}: 发 ${R(n)} 吗？标着它的规则全部已通过。`;

/** Asks the question and records the answer the way a session does: the question tool's record, then the relay. */
function ask(root: string, q: string, label: string, relay: { record: boolean; words?: string } = { record: true }): number {
  const n = Number(/#(\d+)/.exec(agent(root, "human", "ask", q, "--option", "yes,no").out)![1]);
  if (relay.record) {
    const data = { session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { questions: [{ question: q }], answers: { [q]: label } } };
    expect(canon(root, "agent:test", ["human", "record"], { stdin: JSON.stringify(data) }).code).toBe(0);
  }
  expect(agent(root, "human", "answer", String(n), label, "--relayed", relay.words ?? label).code).toBe(0);
  return n;
}

const changeBranches = (root: string) => sh(root, "branch", "--list", "change/*").split("\n").filter(Boolean).length;

describe("canon release ship: the owner's recorded answer", () => {
  test("BR-2331: no answer, an unanswered question, no, a later no, another release's yes, and a relay the question tool did not record are each refused and start nothing", () => {
    const root = fixture();
    const before = changeBranches(root);
    const refused = (why: string) => {
      const r = agent(root, "release", "ship", R(1));
      expect(r.code).toBe(1);
      expect(r.err).toContain(why);
      expect(changeBranches(root)).toBe(before);
      expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'release.ship'").get()!.n).toBe(0);
    };
    refused("canon human ask");
    agent(root, "human", "ask", question(1), "--option", "yes,no");
    refused("canon human ask");
    ask(root, question(12), "yes");
    refused(`no answered question names \`ship ${R(1)}\``);
    ask(root, question(1), "no");
    refused("not yes");
    ask(root, question(1), "yes", { record: false });
    refused("do not match Claude Code's question-tool record");
  });

  test("BR-2331: the latest answer decides, so a no after a yes refuses and a yes after a no lets it pass to the next checks", () => {
    const root = fixture({}, []);
    ask(root, question(1), "yes");
    ask(root, question(1), "no");
    // with no rule tagged the next check (BR-2333) would refuse; the answer being no is said first
    const r = agent(root, "release", "ship", R(1));
    expect(r.code).toBe(1);
    expect(r.err).toContain("no rule is tagged");
    const root2 = fixture();
    ask(root2, question(1), "yes");
    ask(root2, question(1), "no");
    expect(agent(root2, "release", "ship", R(1)).err).toContain("not yes");
  });
});

describe("canon release ship: the owner's words, not only the agent's answer", () => {
  test("BR-2331 BR-2021: the owner chose no in the question tool and the agent records yes over it: the answer is refused (exit 1), so ship still finds no yes", () => {
    const root = fixture();
    const q = question(1);
    const n = Number(/#(\d+)/.exec(agent(root, "human", "ask", q, "--option", "yes,no").out)![1]);
    const data = { session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { questions: [{ question: q }], answers: { [q]: "no" } } };
    expect(canon(root, "agent:test", ["human", "record"], { stdin: JSON.stringify(data) }).code).toBe(0);
    const lie = agent(root, "human", "answer", String(n), "yes", "--relayed", "no");
    expect(lie.code).toBe(1);
    expect(agent(root, "human", "pending").out).toContain(`#${n}`); // still unanswered
    const r = agent(root, "release", "ship", R(1));
    expect([r.code, r.err.includes("no answered question names")]).toEqual([1, true]);
  });

  test("BR-2331: an answer whose relayed words are not yes is refused by ship even when the record holds it (a row that got past the answer check)", () => {
    const root = fixture();
    ask(root, question(1), "no");
    const db = ws(root).db.db;
    db.query("UPDATE questions SET answer = 'yes'").run(); // the stored answer says yes; the words the owner said stay no
    const r = agent(root, "release", "ship", R(1));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the owner's relayed words are "no", not yes`);
  });

  test("BR-2331: only yes and 是 confirm; y, 确认 and 同意 do not, YES does, and 是 relayed with the question tool's record does", () => {
    const refusedFor = (word: string) => {
      const root = fixture();
      // a question without options, so the word is recorded as typed: the vocabulary is ship's to judge
      const q = question(1);
      const n = Number(/#(\d+)/.exec(agent(root, "human", "ask", q).out)![1]);
      const data = { session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { questions: [{ question: q }], answers: { [q]: word } } };
      expect(canon(root, "agent:test", ["human", "record"], { stdin: JSON.stringify(data) }).code).toBe(0);
      expect(agent(root, "human", "answer", String(n), word, "--relayed", word).code).toBe(0);
      return agent(root, "release", "ship", R(1), "--timeout", "5");
    };
    for (const word of ["y", "确认", "同意"]) {
      const r = refusedFor(word);
      expect([word, r.code, r.err.includes("not yes")]).toEqual([word, 1, true]);
    }
    // the words that count get past the owner check; the floor is not what is tested, so see that the refusal is not about the answer
    for (const word of ["YES", "是"]) expect([word, refusedFor(word).err.includes("not yes")]).toEqual([word, false]);
  });
});

describe("canon release ship: what must be passed", () => {
  test("BR-2333 BR-2331: with no yes recorded, planned, waiting-for-rerun and untagged cases are refused with the rules listed; unknown is 3, shipped is 5", () => {
    const planned = fixture({ [`canon/rules/billing/${BR(3)}.md`]: ruleText(3, `release: ${R(1)}\n`, "planned") });
    const a = agent(planned, "release", "ship", R(1));
    expect(a.code).toBe(1);
    expect(a.err).toContain(`${BR(3)} 规则3: 规划中`);
    expect(a.err).not.toContain(BR(1));
    expect(a.err).not.toContain("canon human ask"); // the rules come before the owner's yes
    const rerun = fixture({ [`canon/rules/billing/${BR(4)}.md`]: ruleText(4, `release: ${R(1)}\n`), [`canon/rules/billing/${BR(5)}.md`]: ruleText(5, `release: ${R(1)}\n`, "planned") });
    const b = agent(rerun, "release", "ship", R(1));
    expect(b.err).toContain(`${BR(4)} 规则4: 待重新执行`);
    expect(b.err).toContain(`${BR(5)} 规则5: 规划中`);
    const none = agent(fixture({}, []), "release", "ship", R(1));
    expect([none.code, none.err.includes("no rule is tagged")]).toEqual([1, true]);
    const missing = agent(fixture(), "release", "ship", R(9));
    expect(missing.code).toBe(3);
    const shippedRoot = fixture();
    write(shippedRoot, { [`canon/releases/${R(1)}.md`]: releaseText(1, `status: shipped\nshipped_at: ${"a".repeat(40)}\n`) });
    sh(shippedRoot, "add", "-A");
    sh(shippedRoot, "commit", "-qm", "shipped");
    expect(agent(shippedRoot, "release", "ship", R(1)).code).toBe(5);
  });

  test("BR-2333: a plan tagged with the release blocks shipping until all its steps are done, naming the steps not done", () => {
    const plan = "| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n| 2 | 接口 | 1 |\n| 3 | 界面 | 1 |\n| 4 | 联调 | 2, 3 |\n";
    const change = (n: number, status: string, front: string, body = "") => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${body}## 任务\n\n- [x] x\n`;
    const files = (done: string) => ({
      [`canon/changes/${C(5)}.md`]: change(5, "open", `release: ${R(1)}\n`, `## 计划\n\n${plan}\n`),
      [`canon/changes/${C(6)}.md`]: change(6, "done", `plan: ${C(5)}\nsteps: [${done}]\n`),
    });
    const half = agent(fixture(files("1, 2")), "release", "ship", R(1));
    expect(half.code).toBe(1);
    expect(half.err).toContain(`plan ${C(5)} 变更5: 已完成 2/4; not done: 3, 4`);
    expect(half.err).not.toContain("canon human ask"); // the plans come before the owner's yes, like the rules
    const both = agent(fixture({ ...files("1, 2"), [`canon/rules/billing/${BR(3)}.md`]: ruleText(3, `release: ${R(1)}\n`, "planned") }), "release", "ship", R(1));
    expect(both.code).toBe(1);
    expect(both.err.indexOf(`${BR(3)} 规则3: 规划中`)).toBeGreaterThanOrEqual(0);
    expect(both.err.indexOf(`plan ${C(5)}`)).toBeGreaterThan(both.err.indexOf(`${BR(3)} 规则3`)); // rules first, then plans
    expect(both.err).not.toContain("canon human ask");
    const all = agent(fixture(files("1, 2, 3, 4")), "release", "ship", R(1));
    expect(all.err).not.toContain(`plan ${C(5)}`);
    expect(all.err).toContain("canon human ask"); // past the blockers: the owner's yes is what is missing now
  });

  test("BR-2333: a retired tagged rule does not block", () => {
    const root = fixture({ [`canon/rules/billing/${BR(6)}.md`]: ruleText(6, `release: ${R(1)}\n`, "retired") });
    ask(root, question(1), "no"); // stops after the blockers: the answer is the next refusal, not a blocker
    const r = agent(root, "release", "ship", R(1));
    expect(r.err).not.toContain(BR(6));
    expect(r.err).toContain("not yes");
  });
});

describe("canon release ship: shipping and the landing gate", () => {
  test("BR-2334: without refs/canon/accepted the ship is refused with a canon accept hint; an accepted commit behind main ships the accepted one", () => {
    const root = fixture();
    sh(root, "update-ref", "-d", "refs/canon/accepted");
    ask(root, question(1), "yes");
    const none = agent(root, "release", "ship", R(1));
    expect([none.code, none.err.includes("canon accept")]).toEqual([1, true]);
    const accepted = acceptNow(root);
    write(root, { "unrelated.txt": "x\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "later landing");
    const r = agent(root, "release", "ship", R(1), "--timeout", "5");
    expect([r.code, r.out.includes(`shipped ${R(1)} at ${accepted.slice(0, 9)}`)]).toEqual([0, true]);
    expect(r.out).toContain("behind");
    expect(readFileSync(join(root, `canon/releases/${R(1)}.md`), "utf8")).toContain(`shipped_at: ${accepted}`);
  });

  test("BR-2334: the release changed on main after the acceptance: refused until accepted again", () => {
    const root = fixture();
    ask(root, question(1), "yes");
    write(root, { [`canon/releases/${R(1)}.md`]: releaseText(1, "status: active\n").replace("成功标准的内容", "成功标准改了") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "release edited after accept");
    const stale = agent(root, "release", "ship", R(1));
    expect([stale.code, stale.err.includes("canon accept")]).toEqual([1, true]);
    acceptNow(root);
    expect(agent(root, "release", "ship", R(1), "--timeout", "5").code).toBe(0);
  });

  test("BR-2334 BR-2332 BR-2331: with the relayed yes recorded by the question tool it lands R-1 shipped at main's commit, tags it, and canon check passes", () => {
    const root = fixture();
    const sha = sh(root, "rev-parse", "main").trim();
    ask(root, question(1), "yes");
    const r = agent(root, "release", "ship", R(1), "--timeout", "5");
    expect([r.code, r.out.includes(`shipped ${R(1)} at ${sha.slice(0, 9)}`)]).toEqual([0, true]);
    expect(r.out).toMatch(/in chore-[0-9a-f-]+, landed/); // the ship is a chore: no Change document, no C number (BR-2334)
    expect(sh(root, "ls-tree", "--name-only", "main", "canon/changes/")).not.toMatch(/发布/);
    const doc = readFileSync(join(root, `canon/releases/${R(1)}.md`), "utf8");
    expect(doc).toContain("status: shipped");
    expect(doc).toContain(`shipped_at: ${sha}`);
    expect(sh(root, "rev-parse", `release/${R(1)}`).trim()).toBe(sha);
    expect(sh(root, "status", "--porcelain")).toBe("");
    expect(agent(root, "check").out).toContain("ok:");
    expect(sh(root, "log", "--format=%s", "-8")).toContain(`Ship ${R(1)} at ${sha.slice(0, 9)}`);
  });

  test("BR-2334 BR-2331: run from another change's worktree it ships too, and a human's direct yes at a terminal counts", () => {
    const root = fixture();
    const other = startNew(root, "Other work");
    const q = question(1);
    const n = Number(/#(\d+)/.exec(agent(root, "human", "ask", q, "--option", "yes,no").out)![1]);
    expect(canon(root, "human:dz", ["human", "answer", String(n), "yes"], { tty: true }).code).toBe(0);
    const r = agent(other.worktree, "release", "ship", R(1), "--timeout", "5");
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, `canon/releases/${R(1)}.md`), "utf8")).toContain("status: shipped");
    expect(existsSync(join(other.worktree, "canon/changes"))).toBe(true);
  });

  test("BR-2334: a landing that is refused leaves R-1 unshipped and makes no tag", () => {
    const root = fixture();
    write(root, { FAIL: "x\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "floor fails");
    ask(root, question(1), "yes");
    const r = agent(root, "release", "ship", R(1), "--timeout", "5");
    expect(r.code).toBe(1);
    expect(r.err).toContain("chore-"); // the refused ship names its chore and keeps it for the retry (BR-2334)
    expect(sh(root, "show", `main:canon/releases/${R(1)}.md`)).not.toContain("status: shipped");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/tags/release/${R(1)}`], { cwd: root }).exitCode).not.toBe(0);
  });

  test("BR-2334: a tag that cannot be made is a warning, the landed record stands and the exit code is 0", () => {
    const root = fixture();
    sh(root, "tag", `release/${R(1)}`, "HEAD~1");
    ask(root, question(1), "yes");
    const r = agent(root, "release", "ship", R(1), "--timeout", "5");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning");
    expect(readFileSync(join(root, `canon/releases/${R(1)}.md`), "utf8")).toContain("status: shipped");
  });

  test("BR-2332: a hand-written shipped, a new release written as shipped, and an unshipped, changed or deleted shipped release are refused with reason release; other edits land", async () => {
    const root = fixture();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    const fail = async (title: string, files: Record<string, string | null>) => {
      const s = startNew(root, title);
      for (const [p, text] of Object.entries(files)) {
        if (text === null) sh(s.worktree, "rm", "-q", p);
        else write(s.worktree, { [p]: text });
      }
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", title);
      return land(ws(s.worktree), FAST, quiet);
    };
    const hand = await fail("hand written", { [`canon/releases/${R(1)}.md`]: releaseText(1, `status: shipped\nshipped_at: ${sha}\n`) });
    expect(hand.kind === "refused" && [hand.reason, hand.message.includes(`canon release ship ${R(1)}`)]).toEqual(["release", true]);
    const created = await fail("new shipped", { [`canon/releases/${R(2)}.md`]: releaseText(2, `status: shipped\nshipped_at: ${sha}\n`) });
    // reason: a release that never existed cannot name a commit that held it, so canon check refuses it before the release gate does (BR-2325)
    expect(created.kind === "refused" && [created.reason, created.findings?.map((f) => f.rule)]).toEqual(["check", ["release-frozen"]]);
    const ok = await fail("move to active", { [`canon/releases/${R(1)}.md`]: releaseText(1, "status: planned\n") });
    expect(ok.kind).toBe("landed");
    // R-1 shipped on main through the command; then the three ways to undo it
    const shipped = fixture();
    ask(shipped, question(1), "yes");
    expect(agent(shipped, "release", "ship", R(1), "--timeout", "5").code).toBe(0);
    const text = readFileSync(join(shipped, `canon/releases/${R(1)}.md`), "utf8");
    const attempt = async (title: string, change: (t: string) => string | null) => {
      const s = startNew(shipped, title);
      const next = change(text);
      if (next === null) sh(s.worktree, "rm", "-q", `canon/releases/${R(1)}.md`);
      else write(s.worktree, { [`canon/releases/${R(1)}.md`]: next });
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", title);
      return land(ws(s.worktree), FAST, quiet);
    };
    // reason: deleting a release that rules still name is ref-dangling, and a shipped_at that names no commit holding it is release-frozen: canon check refuses those first; only an unship reaches the release gate
    const expected: Record<string, [string, string | undefined]> = { unship: ["release", undefined], delete: ["check", "ref-dangling"], move: ["check", "release-frozen"] };
    for (const [title, change] of [["unship", (t: string) => t.replace("status: shipped", "status: active").replace(/shipped_at: .*\n/, "")], ["delete", () => null], ["move", (t: string) => t.replace(/shipped_at: .*/, `shipped_at: ${"b".repeat(40)}`)]] as const) {
      const out = await attempt(title, change);
      const rules = out.kind === "refused" ? [...new Set(out.findings?.map((f) => f.rule))].join() : undefined;
      expect([title, out.kind === "refused" && out.reason, out.kind === "refused" && (rules || undefined)]).toEqual([title, ...expected[title]!]);
    }
    const fine = await attempt("edit success criteria", (t) => t.replace("成功标准的内容", "成功标准改了"));
    expect(fine.kind).toBe("landed");
  });
});

describe("canon release ship: conditions checked again when the change lands", () => {
  /** Ships R-1 while main's floor fails, so the ship change is committed but not landed; then main is repaired. Returns the ship change's worktree. */
  function stuckShip(extra: Record<string, string> = {}): { root: string; worktree: string; accepted: string } {
    const root = fixture(extra);
    write(root, { FAIL: "x\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "floor fails");
    ask(root, question(1), "yes");
    expect(agent(root, "release", "ship", R(1), "--timeout", "5").code).toBe(1);
    const block = sh(root, "worktree", "list", "--porcelain").split("\n\n").find((b) => b.includes("branch refs/heads/chore/"))!;
    const worktree = block.split("\n")[0]!.slice("worktree ".length);
    sh(root, "rm", "-q", "FAIL");
    sh(root, "commit", "-qm", "floor repaired");
    return { root, worktree, accepted: sh(root, "rev-parse", "refs/canon/accepted").trim() };
  }
  const land = (worktree: string) => canon(worktree, "agent:test", ["work", "land", "--finish", "--timeout", "5"]);
  const shipped = (root: string) => sh(root, "show", `main:canon/releases/${R(1)}.md`).includes("status: shipped");
  const rule1 = (root: string) => join(root, `canon/rules/billing/${BR(1)}.md`);

  test("BR-2335: a rule that became waiting for rerun after ship started no longer refuses the landing: the accepted snapshot ships", () => {
    const { root, worktree } = stuckShip();
    const original = readFileSync(rule1(root), "utf8");
    writeFileSync(rule1(root), original.replace("规则1的行为。", "规则1的行为变了。"));
    sh(root, "commit", "-qam", "rule 1 changes");
    // reason: the shipped content is the accepted snapshot; conditions are not recomputed at the landing (D-105, BR-2335)
    const r = land(worktree);
    expect([r.code, shipped(root)]).toEqual([0, true]);
    expect(r.err).not.toContain("待重新执行");
  });

  test("BR-2335: the landing refuses when refs/canon/accepted is gone or shipped_at has no accept.ok, and lands once both are back", () => {
    const { root, worktree, accepted } = stuckShip();
    sh(root, "update-ref", "-d", "refs/canon/accepted");
    const gone = land(worktree);
    expect([gone.code, gone.err.includes("refs/canon/accepted")]).toEqual([1, true]);
    expect(shipped(root)).toBe(false);
    sh(root, "update-ref", "refs/canon/accepted", accepted);
    ws(root).db.db.query("DELETE FROM events WHERE kind = 'accept.ok'").run();
    const noEvent = land(worktree);
    expect([noEvent.code, noEvent.err.includes("accept.ok")]).toEqual([1, true]);
    // reason: the landing wants the acceptance of shipped_at itself, not of whatever the ref points at now (BR-2335)
    ws(root).db.event("human:owner", "accept.ok", null, { commit: accepted });
    const again = land(worktree);
    expect([again.code, shipped(root)]).toEqual([0, true]);
  });

  test("BR-2335: a no the owner gave after ship started refuses the landing with reason release; a later yes lets a direct land --finish through", () => {
    const { root, worktree } = stuckShip();
    ask(root, question(1), "no");
    const r = land(worktree);
    expect([r.code, r.err.includes("release"), r.err.includes("confirmation no longer stands")]).toEqual([1, true, true]);
    expect(shipped(root)).toBe(false);
    expect(land(worktree).code).toBe(1);
    ask(root, question(1), "yes");
    const again = land(worktree);
    expect([again.code, shipped(root)]).toEqual([0, true]);
  });

  test("BR-2335: nothing changed after ship started: the landing goes through (BR-2334)", () => {
    const { root, worktree } = stuckShip();
    const r = land(worktree);
    expect([r.code, shipped(root)]).toEqual([0, true]);
    expect(r.out).toContain("completed"); // the retried ship is a chore: completing it releases the claim, no Change closes (BR-2335, BR-2458)
  });
});

describe("the landing gate from the command line", () => {
  test("BR-2332: a hand-written shipped release is refused by `canon work land --finish` itself (exit 1, reason release) and main keeps the old text; the same landing without it succeeds", () => {
    const root = fixture();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    const s = startNew(root, "hand written");
    const changeFile = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(`${s.change}`))!);
    writeFileSync(changeFile, readFileSync(changeFile, "utf8").replace("- [ ]", "- [x]"));
    write(s.worktree, { [`canon/releases/${R(1)}.md`]: releaseText(1, `status: shipped\nshipped_at: ${sha}\n`) });
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "hand written");
    const r = canon(s.worktree, "agent:a", ["work", "land", "--finish", "--timeout", "5"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`canon release ship ${R(1)}`);
    expect(r.err).toContain("release");
    expect(sh(root, "show", `main:canon/releases/${R(1)}.md`)).not.toContain("status: shipped");
    // the same change with an edit that is not a shipping lands through the same entry point
    write(s.worktree, { [`canon/releases/${R(1)}.md`]: releaseText(1, "status: planned\n") });
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "planned instead");
    const ok = canon(s.worktree, "agent:a", ["work", "land", "--finish", "--timeout", "5"]);
    expect([ok.code, sh(root, "show", `main:canon/releases/${R(1)}.md`).includes("status: planned")]).toEqual([0, true]);
  });
});
