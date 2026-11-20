import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../work/humans/questions.ts";
import { land } from "../../work/land/land.ts";
import { startChore } from "../../work/session/session.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";

// reason: every case lands through the real queue, which under load takes seconds (as in goal-landing.test.ts)
setDefaultTimeout(120_000);

const id = (p: string, n: number) => [p, n].join("-");
const Q = (n: number) => id("Q", n);
const README = "canon/quality/README.md";

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const standard = (n: number, status: string, threshold = "打击后停顿 3 到 5 帧。") =>
  `---\nid: ${Q(n)}\ntitle: 标准${n}\nstatus: ${status}\n${status === "retired" ? "retired_reason: 不做实时战斗\n" : ""}aspect: 战斗手感\njudge: owner\ncovers: [.]\n---\n\n## 门槛\n\n${threshold}\n\n## 来源\n\n- 暖雪录帧\n`;

/** Q-1 draft, Q-3 retired and Q-5 active on main, with the aspect list. */
function fixture(): string {
  const root = project();
  write(root, { [README]: "# 质量标准\n\n## 方面\n\n- **战斗手感**：\n", [`canon/quality/${Q(1)}.md`]: standard(1, "draft"), [`canon/quality/${Q(3)}.md`]: standard(3, "retired"), [`canon/quality/${Q(5)}.md`]: standard(5, "active") });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

/** A question asked for `subject` and, when `answered`, answered; its number. */
function question(root: string, subject: string | null, answered: boolean): number {
  const db = ws(root).db;
  const n = ask(db, "agent:a", subject, "Q 确认吗？", ["是", "否"]);
  if (answered) db.db.query("UPDATE questions SET answer = '是', answered_by = 'human:o' WHERE id = ?").run(n);
  return n;
}

/** Starts a change writing `files` (removing `remove`), with `owner_answers` from `answers(change id)` when given, and lands it. */
async function attempt(root: string, title: string, files: Record<string, string>, answers?: (change: string) => string, remove: readonly string[] = []) {
  const s = startNew(root, title);
  write(s.worktree, files);
  for (const p of remove) rmSync(join(s.worktree, p));
  if (answers !== undefined) {
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}`))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: open\n", `status: open\nowner_answers: ${answers(s.change)}\n`));
  }
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const outcome = await land(ws(s.worktree), FAST, quiet);
  return { reason: outcome.kind === "refused" ? outcome.reason : outcome.kind, message: outcome.kind === "refused" ? outcome.message : "" };
}

describe("a quality standard becomes active only with the owner's answer", () => {
  test("BR-2560: draft to active needs an answered question asked for this change: none, unanswered or asked for another change is refused", async () => {
    const root = fixture();
    const confirm = { [`canon/quality/${Q(1)}.md`]: standard(1, "active") };
    const none = await attempt(root, "确认", confirm);
    expect(none.reason).toBe("quality");
    expect(none.message).toContain(Q(1));
    expect(none.message).toContain("canon human ask --change");
    const old = question(root, null, true);
    expect((await attempt(root, "确认 2", confirm, () => `[${old}]`)).reason).toBe("quality");
    expect((await attempt(root, "确认 3", confirm, (c) => `[${question(root, c, false)}]`)).reason).toBe("quality");
    expect((await attempt(root, "确认 4", confirm, (c) => `[${question(root, c, true)}]`)).reason).toBe("landed");
  });

  test("BR-2560: a new standard written active and a retired one made active again are refused without the owner; a chore cannot make one active", async () => {
    const root = fixture();
    expect((await attempt(root, "新建就 active", { [`canon/quality/${Q(2)}.md`]: standard(2, "active") })).reason).toBe("quality");
    expect((await attempt(root, "复活", { [`canon/quality/${Q(3)}.md`]: standard(3, "active") })).reason).toBe("quality");
    const c = startChore(ws(root), { title: "顺手确认" }, quiet);
    if (!c.ok) throw new Error(c.error.message);
    write(c.value.worktree, { [`canon/quality/${Q(1)}.md`]: standard(1, "active") });
    sh(c.value.worktree, "add", "-A");
    sh(c.value.worktree, "commit", "-qm", "chore");
    const o = await land(ws(c.value.worktree), FAST, quiet);
    expect([o.kind === "refused" ? o.reason : o.kind, o.kind === "refused" && o.message.includes("a chore cannot")]).toEqual(["quality", true]);
  });

  test("BR-2560: everything else lands without the owner: a new draft, retiring or editing an active one, active back to draft, a moved active one", async () => {
    const root = fixture();
    expect((await attempt(root, "新草稿", { [`canon/quality/${Q(4)}.md`]: standard(4, "draft") })).reason).toBe("landed");
    expect((await attempt(root, "改门槛", { [`canon/quality/${Q(5)}.md`]: standard(5, "active", "打击后停顿 4 到 6 帧。") })).reason).toBe("landed");
    expect((await attempt(root, "改名", { [`canon/quality/${Q(5)}-hit-stop.md`]: standard(5, "active", "打击后停顿 4 到 6 帧。") }, undefined, [`canon/quality/${Q(5)}.md`])).reason).toBe("landed");
    expect((await attempt(root, "退回", { [`canon/quality/${Q(5)}-hit-stop.md`]: standard(5, "draft", "打击后停顿 4 到 6 帧。") })).reason).toBe("landed");
    expect((await attempt(root, "退役", { [`canon/quality/${Q(1)}.md`]: standard(1, "retired") })).reason).toBe("landed");
  });
});
