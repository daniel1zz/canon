import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { land } from "../land.ts";

// reason: each case lands once or twice; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });

const id = (p: string, n: number) => [p, n].join("-");
const finish = (wt: string) => land(ws(wt, "agent:a"), { ...FAST, finish: true }, quiet);
function cli(cwd: string, args: readonly string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}

/** A project whose main has decision D-1 and domain billing with business 退款; a change started on it. */
function started() {
  const root = project(); roots.push(root);
  mkdirSync(join(root, "canon/decisions"), { recursive: true });
  writeFileSync(join(root, `canon/decisions/${id("D", 1)}.md`), `---\nid: ${id("D", 1)}\ntitle: Old\nstatus: accepted\n---\n## 背景\n\nb\n\n## 方案\n\n- 采用 x\n- 否决 y\n\n## 决定\n\nd\n\n## 后果\n\nc\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/x.ts"), "export {};\n");
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **退款**：钱怎么退回去\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture: decision and domain");
  const s = startNew(root, "Fields");
  const changeFile = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(`${s.change}-`) || f === `${s.change}.md`)!);
  return { root, ...s, changeFile };
}
const commit = (wt: string) => { sh(wt, "add", "-A"); sh(wt, "commit", "-qm", "edit"); };

test("BR-2624: a change file the branch adds without owner_gate and advances is refused before queueing with a canon doc set line each; set, it lands", async () => {
  const f = started();
  writeFileSync(f.changeFile, readFileSync(f.changeFile, "utf8").replace(/owner_gate: .*\n/, "").replace(/advances: .*\n/, ""));
  commit(f.worktree);
  const refused = await finish(f.worktree);
  expect(refused).toMatchObject({ kind: "refused", reason: "fields" });
  const message = refused.kind === "refused" ? refused.message : "";
  expect(message).toContain(`canon doc set ${f.change} owner_gate "<value>", the value a text saying what the owner approves, or "none: <reason>"`);
  expect(message).toContain(`canon doc set ${f.change} advances "<value>"`);
  expect(ws(f.root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'land.refuse' AND json_extract(detail, '$.reason') = 'fields'").get()!.n).toBe(1);
  expect(cli(f.worktree, ["doc", "set", f.change, "owner_gate", "none: 内部工具"]).code).toBe(0);
  expect(cli(f.worktree, ["doc", "set", f.change, "advances", "none: 修 bug"]).code).toBe(0);
  commit(f.worktree);
  expect(await finish(f.worktree)).toMatchObject({ kind: "landed", finished: true });
});

test("BR-2624 BR-2623: an added decision revising an existing one needs revised_because; amends none or a missing id does not; a decision already on main is not checked", async () => {
  const f = started();
  const decision = (n: number, extra: string) => `---\nid: ${id("D", n)}\ntitle: New ${n}\nstatus: proposed\n${extra}---\n## 背景\n\nb\n\n## 方案\n\n- 采用 x\n- 否决 y\n\n## 决定\n\nd\n\n## 后果\n\nc\n`;
  writeFileSync(join(f.worktree, `canon/decisions/${id("D", 2)}.md`), decision(2, `amends: [${id("D", 1)}]\n`));
  writeFileSync(join(f.worktree, `canon/decisions/${id("D", 3)}.md`), decision(3, 'amends: "none: 新的选择"\n'));
  writeFileSync(join(f.worktree, `canon/decisions/${id("D", 4)}.md`), decision(4, ""));
  // the decision already on main has no amends: an old document is not checked
  writeFileSync(join(f.worktree, `canon/decisions/${id("D", 1)}.md`), readFileSync(join(f.worktree, `canon/decisions/${id("D", 1)}.md`), "utf8").replace("d\n", "d, reworded\n"));
  commit(f.worktree);
  const refused = await finish(f.worktree);
  const message = refused.kind === "refused" ? refused.message : "";
  expect(refused).toMatchObject({ kind: "refused", reason: "fields" });
  expect(message).toContain(`canon doc set ${id("D", 2)} revised_because "<value>", the value one of premise, requirement`);
  expect(message).toContain(`canon doc set ${id("D", 4)} amends "<value>"`);
  expect(message).not.toContain(`${id("D", 3)} (`);
  expect(message).not.toContain(`${id("D", 1)} (`);
  expect(message).not.toContain(`${id("D", 2)} (canon/decisions/${id("D", 2)}.md) has no amends`);
});

test("BR-2624: an added rule without business is refused with its domain's businesses", async () => {
  const f = started();
  writeFileSync(join(f.worktree, `canon/rules/billing/${id("BR", 1)}.md`), `---\nid: ${id("BR", 1)}\ntitle: R\nuntested: fixture\n---\n## 规则\n\nS.\n\n## 例子\n\n- a → b\n`);
  commit(f.worktree);
  const refused = await finish(f.worktree);
  expect(refused).toMatchObject({ kind: "refused", reason: "fields" });
  expect(refused.kind === "refused" && refused.message).toContain(`canon doc set ${id("BR", 1)} business "<value>", the value one of the businesses billing's README lists: 退款`);
});
