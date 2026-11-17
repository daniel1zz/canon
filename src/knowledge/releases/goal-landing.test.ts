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
const CRITERIA = "- 负责人玩通主线。（待负责人）\n- 没人解释也能玩。";
const R5 = (front = `status: active\nfeatures: [${F(1)}, ${F(2)}]\n`, criteria = CRITERIA) => release(5, front, criteria);

function fixture(): string {
  const root = project();
  write(root, { [`canon/features/${F(1)}.md`]: feature(1), [`canon/features/${F(2)}.md`]: feature(2), [`canon/features/${F(3)}.md`]: feature(3), [`canon/releases/${R(5)}.md`]: R5(), [`canon/releases/${R(6)}.md`]: release(6, "status: planned\n", "- 内容") });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

/** A question asked and, when `answered`, answered; its number. */
function question(root: string, answered: boolean): number {
  const db = ws(root).db;
  const n = ask(db, "agent:a", null, "要改目标吗？", ["是", "否"]);
  if (answered) db.db.query("UPDATE questions SET answer = '是', answered_by = 'human:o' WHERE id = ?").run(n);
  return n;
}

/** Lands a new change writing `files`, with `owner_answers` when given; the outcome. */
async function attempt(root: string, title: string, files: Record<string, string>, answers?: string) {
  const s = startNew(root, title);
  write(s.worktree, files);
  if (answers !== undefined) {
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}`))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: open\n", `status: open\nowner_answers: ${answers}\n`));
  }
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  return land(ws(s.worktree), FAST, quiet);
}

const refused = (o: Awaited<ReturnType<typeof land>>) => (o.kind === "refused" ? [o.reason, o.message] : [o.kind, ""]);

describe("the goal is the owner's", () => {
  test("BR-2510: an added criterion needs an answered question in owner_answers: none or an unanswered one is refused, an answered one lands", async () => {
    const root = fixture();
    const added = { [`canon/releases/${R(5)}.md`]: R5(undefined, `${CRITERIA}\n- 支持手柄。`) };
    const [reason, message] = refused(await attempt(root, "加标准", added));
    expect(reason).toBe("release");
    expect([message.includes(R(5)), message.includes("支持手柄"), message.includes("owner_answers")]).toEqual([true, true, true]);
    const pending = question(root, false);
    expect(refused(await attempt(root, "加标准 2", added, `[${pending}]`))[0]).toBe("release");
    const yes = question(root, true);
    expect((await attempt(root, "加标准 3", added, `[${yes}]`)).kind).toBe("landed");
  });

  test("BR-2510: marks between met, unmet and unproven, ids reordered and start land without answers; leaving 待负责人, a feature added or a drop do not", async () => {
    const root = fixture();
    expect((await attempt(root, "标记", { [`canon/releases/${R(5)}.md`]: R5(undefined, "- 负责人玩通主线。（待负责人）\n- 没人解释也能玩。（未满足：还差引导）") })).kind).toBe("landed");
    expect((await attempt(root, "换顺序", { [`canon/releases/${R(5)}.md`]: R5(`status: active\nfeatures: [${F(2)}, ${F(1)}]\n`, "- 负责人玩通主线。（待负责人）\n- 没人解释也能玩。（未满足：还差引导）") })).kind).toBe("landed");
    expect((await attempt(root, "开工", { [`canon/releases/${R(6)}.md`]: release(6, "status: active\n", "- 内容") })).kind).toBe("landed");
    const now = "- 没人解释也能玩。（未满足：还差引导）";
    expect(refused(await attempt(root, "验收", { [`canon/releases/${R(5)}.md`]: R5(`status: active\nfeatures: [${F(2)}, ${F(1)}]\n`, `- 负责人玩通主线。（已满足：${id("C", 1)}）\n${now}`) }))[1]).toContain("no longer waits for the owner");
    expect(refused(await attempt(root, "加模块", { [`canon/releases/${R(5)}.md`]: R5(`status: active\nfeatures: [${F(2)}, ${F(1)}, ${F(3)}]\n`, `- 负责人玩通主线。（待负责人）\n${now}`) }))[1]).toContain(`features [${F(2)}, ${F(1)}] → [${F(2)}, ${F(1)}, ${F(3)}]`);
    expect(refused(await attempt(root, "取消", { [`canon/releases/${R(6)}.md`]: release(6, `status: dropped\nmerged_into: ${R(5)}\n`, "- 内容") }))[1]).toContain(`${R(6)}: status active → dropped`);
  });

  test("BR-2510: a chore that changes a criterion is refused whatever it names", async () => {
    const root = fixture();
    const c = startChore(ws(root), { title: "顺手改字" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    write(c.value.worktree, { [`canon/releases/${R(5)}.md`]: R5(undefined, "- 负责人玩通全部主线。（待负责人）\n- 没人解释也能玩。") });
    sh(c.value.worktree, "add", "-A");
    sh(c.value.worktree, "commit", "-qm", "chore");
    const [reason, message] = refused(await land(ws(c.value.worktree), FAST, quiet));
    expect([reason, message.includes("a chore cannot")]).toEqual(["release", true]);
  });

  test("BR-2510: owner_answers that is not a list of question numbers makes the change file invalid", async () => {
    const root = fixture();
    const [reason] = refused(await attempt(root, "坏字段", {}, "[abc]"));
    expect(reason).toBe("check");
  });
});
