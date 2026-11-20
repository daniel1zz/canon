import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../work/humans/questions.ts";
import { land } from "../../work/land/land.ts";
import { startChore } from "../../work/session/session.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";

// reason: every case lands through the real queue, which under load takes seconds (as in ship.test.ts)
setDefaultTimeout(120_000);

const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const F = (n: number) => id("F", n);

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const SECTIONS = (criteria: string) => ["目标", "用户", "范围", "不做"].map((s) => `## ${s}\n\n内容\n`).join("\n") + `\n## 成功标准\n\n${criteria}\n\n## 故事地图切片\n\n内容\n`;
const release = (n: number, front: string, criteria: string) => `---\nid: ${R(n)}\ntitle: 版本${n}\n${front}---\n\n${SECTIONS(criteria)}`;
const feature = (n: number) => `---\nid: ${F(n)}\ntitle: 模块${n}\nstatus: active\n---\n\n${["目标", "范围", "不做", "成功标准"].map((s) => `## ${s}\n\n内容\n`).join("\n")}`;
const CRITERIA = "- S1 负责人玩通主线。（待负责人）\n- S2 没人解释也能玩。";
const R5 = (front = `status: active\nfeatures: [${F(1)}, ${F(2)}]\n`, criteria = CRITERIA) => release(5, front, criteria);

function fixture(): string {
  const root = project();
  write(root, { [`canon/features/${F(1)}.md`]: feature(1), [`canon/features/${F(2)}.md`]: feature(2), [`canon/features/${F(3)}.md`]: feature(3), [`canon/releases/${R(5)}.md`]: R5(), [`canon/releases/${R(6)}.md`]: release(6, "status: planned\n", "- 内容") });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

/** A question asked for `subject` and, when `answered`, answered; its number. */
function question(root: string, subject: string | null, answered: boolean): number {
  const db = ws(root).db;
  const n = ask(db, "agent:a", subject, "负责人玩通了吗？", ["是", "否"]);
  if (answered) db.db.query("UPDATE questions SET answer = '是', answered_by = 'human:o' WHERE id = ?").run(n);
  return n;
}

/** Starts a change writing `files`, with `owner_answers` from `answers(change id)` when given; lands it, keeping what it said. */
async function attempt(root: string, title: string, files: Record<string, string>, answers?: (change: string) => string, front = "") {
  const s = startNew(root, title);
  write(s.worktree, files);
  if (answers !== undefined || front !== "") {
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}`))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: open\n", `status: open\n${answers !== undefined ? `owner_answers: ${answers(s.change)}\n` : ""}${front}`));
  }
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const said: string[] = [];
  const outcome = await land(ws(s.worktree), FAST, (l: string) => said.push(l));
  return { outcome, said: said.join("\n"), change: s.change };
}

const reasonOf = (o: Awaited<ReturnType<typeof land>>) => (o.kind === "refused" ? o.reason : o.kind);
const messageOf = (o: Awaited<ReturnType<typeof land>>) => (o.kind === "refused" ? o.message : "");
const ACCEPTED = `- S1 负责人玩通主线。（已满足：${F(1)}）\n- S2 没人解释也能玩。`;

describe("the goal: the AI may change it, the owner sees it", () => {
  test("BR-2510: an added criterion, a feature added and a drop land without the owner and list each change; marks and a reorder list nothing", async () => {
    const root = fixture();
    const added = await attempt(root, "加标准", { [`canon/releases/${R(5)}.md`]: R5(undefined, `${CRITERIA}\n- S3 支持手柄。`) });
    expect(reasonOf(added.outcome)).toBe("landed");
    expect(added.said).toContain(`goal: ${added.change} changes the goal:`);
    expect(added.said).toMatch(new RegExp(`${R(5)}: success criterion added or reworded: 支持手柄`));
    const more = await attempt(root, "加模块", { [`canon/releases/${R(5)}.md`]: R5(`status: active\nfeatures: [${F(1)}, ${F(2)}, ${F(3)}]\n`, `${CRITERIA}\n- S3 支持手柄。`) });
    expect([reasonOf(more.outcome), more.said.includes(`features [${F(1)}, ${F(2)}] → [${F(1)}, ${F(2)}, ${F(3)}]`)]).toEqual(["landed", true]);
    const dropped = await attempt(root, "取消", { [`canon/releases/${R(6)}.md`]: release(6, `status: dropped\nmerged_into: ${R(5)}\n`, "- 内容") });
    expect([reasonOf(dropped.outcome), dropped.said.includes(`${R(6)}: status planned → dropped`)]).toEqual(["landed", true]);
    const marks = await attempt(root, "标记和换顺序", { [`canon/releases/${R(5)}.md`]: R5(`status: active\nfeatures: [${F(3)}, ${F(2)}, ${F(1)}]\n`, `- S1 负责人玩通主线。（待负责人）\n- S2 没人解释也能玩。（未满足：还差引导）\n- S3 支持手柄。`) });
    expect([reasonOf(marks.outcome), marks.said.includes("goal:")]).toEqual(["landed", false]);
  });

  test("BR-2510: leaving 待负责人 needs an answered question asked for this change: none, unanswered or asked for another change is refused, and so is rewording or removing it", async () => {
    const root = fixture();
    const accept = { [`canon/releases/${R(5)}.md`]: R5(undefined, ACCEPTED) };
    const none = await attempt(root, "验收", accept);
    expect([reasonOf(none.outcome), messageOf(none.outcome).includes("负责人玩通主线")]).toEqual(["release", true]);
    const old = question(root, null, true);
    expect(reasonOf((await attempt(root, "验收 2", accept, () => `[${old}]`)).outcome)).toBe("release");
    const pending = await attempt(root, "验收 3", accept, (c) => `[${question(root, c, false)}]`);
    expect(reasonOf(pending.outcome)).toBe("release");
    const reworded = await attempt(root, "改字验收", { [`canon/releases/${R(5)}.md`]: R5(undefined, `- S1 负责人玩通了主线。（已满足：${F(1)}）\n- S2 没人解释也能玩。`) });
    expect(reasonOf(reworded.outcome)).toBe("release");
    const removed = await attempt(root, "删掉", { [`canon/releases/${R(5)}.md`]: R5(undefined, "- S2 没人解释也能玩。") });
    expect(reasonOf(removed.outcome)).toBe("release");
    const yes = await attempt(root, "验收 4", accept, (c) => `[${question(root, c, true)}]`);
    expect(reasonOf(yes.outcome)).toBe("landed");
  });

  test("BR-2510: a chore that changes a criterion is refused and told to use a change", async () => {
    const root = fixture();
    const c = startChore(ws(root), { title: "顺手改字" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    write(c.value.worktree, { [`canon/releases/${R(5)}.md`]: R5(undefined, "- S1 负责人玩通全部主线。（待负责人）\n- S2 没人解释也能玩。") });
    sh(c.value.worktree, "add", "-A");
    sh(c.value.worktree, "commit", "-qm", "chore");
    const o = await land(ws(c.value.worktree), FAST, quiet);
    expect([reasonOf(o), messageOf(o).includes("a chore cannot")]).toEqual(["release", true]);
  });

  test("BR-2510: owner_answers that is not a list of question numbers makes the change file invalid", async () => {
    const root = fixture();
    expect(reasonOf((await attempt(root, "坏字段", {}, () => "[abc]")).outcome)).toBe("check");
  });
});

describe("what a landing says about advances", () => {
  test("BR-2517: a change without advances or with none is said at landing and lands; one naming criteria says nothing; a chore says nothing", async () => {
    const root = fixture();
    const missing = await attempt(root, "没写", { "notes.txt": "a\n" });
    expect([reasonOf(missing.outcome), missing.said.includes(`advances: ${missing.change} names no success criterion it advances`)]).toEqual(["landed", true]);
    const none = await attempt(root, "不推进", { "notes.txt": "b\n" }, undefined, 'advances: "none: 修 YAML 转义"\n');
    expect([reasonOf(none.outcome), none.said.includes(`advances: ${none.change} advances no success criterion: 修 YAML 转义`)]).toEqual(["landed", true]);
    const c = startChore(ws(root), { title: "顺手" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    write(c.value.worktree, { "notes.txt": "c\n" });
    sh(c.value.worktree, "add", "-A");
    sh(c.value.worktree, "commit", "-qm", "chore");
    const said: string[] = [];
    expect((await land(ws(c.value.worktree), FAST, (l: string) => said.push(l))).kind).toBe("landed");
    expect(said.join("\n")).not.toContain("advances:");
  });
});
