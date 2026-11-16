import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate } from "../../delegation/delegate.ts";
import { acceptDesign } from "../../delegation/accept-design.ts";
import { needDesign } from "../../delegation/requests.ts";
import { processOf } from "../../claims/liveness.ts";
import { start } from "../../session/session.ts";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { HAND_BACK } from "./delegation.ts";

const OWNER = "agent:s1";
const W1 = "agent:s7:w1";
const CLI = join(import.meta.dir, "../../../invocation/main.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });

const rule = (id: string, body: string, status = "planned", extra = "") => `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nbusiness: dispatch\nuntested: fixture\n${extra}---\n\n## 规则\n\n${body}\n\n## 例子\n\n- Works.\n`;
const README = "---\ncode: [lib]\n---\n# task\n\nTasks.\n\n## 业务\n\n- **dispatch**：派发\n\n## 术语\n\n- **任务**：要做的事\n";
const DECISION = "---\nid: D-40\ntitle: Contract\nstatus: accepted\n---\n\n## 背景\n\nWhy.\n\n## 方案\n\n1. A contract：采用。\n2. No contract：否决。\n\n## 决定\n\nUse a contract.\n\n## 后果\n\nNone.\n";
function put(dir: string, path: string, text: string) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
function commit(dir: string, message = "edit") { sh(dir, "add", "-A"); sh(dir, "commit", "-qm", message); }
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
function changeFile(wt: string, change: string) { return `canon/changes/${readdirSync(join(wt, "canon/changes")).find((p) => p.startsWith(`${change}-`) || p === `${change}.md`)!}`; }

/**
 * A change C-n of agent:s1 whose `rules:` is [BR-50], published on main with D-40, BR-30, product.md and the
 * design_paths file docs/DESIGN.md, delegated to w1 and claimed by agent:s7:w1.
 */
function fixture(o: { willAmend?: boolean; config?: string } = {}) {
  const root = project(); roots.push(root);
  put(root, "canon/config.yaml", `floor: test ! -e FAIL\ntests: []\nreview: none\ndesign_paths: [docs/DESIGN.md]\n${o.config ?? ""}`);
  put(root, "canon/product.md", "# Product\n\nShared work.\n");
  put(root, "canon/rules/task/BR-50.md", rule("BR-50", "Use D-40.", "planned", o.willAmend ? "will_amend: [BR-30]\n" : ""));
  put(root, "canon/rules/task/BR-30.md", rule("BR-30", "No further reference.", "active"));
  put(root, "canon/rules/task/README.md", README); put(root, "lib/task.txt", "task\n");
  put(root, "canon/decisions/D-40.md", DECISION);
  put(root, "docs/DESIGN.md", "# Design\n\nFirst.\n");
  commit(root, "design");
  const s = startNew(root, "Worker task", OWNER);
  const path = changeFile(s.worktree, s.change);
  put(s.worktree, path, read(s.worktree, path).replace(/rules: \[\]/, "rules: [BR-50]"));
  commit(s.worktree, "rules");
  const d = delegate(ws(root, OWNER), s.change, "w1", [], quiet);
  if (!d.ok) throw new Error(d.error.message);
  const claimed = start(ws(root, W1), { change: s.change }, quiet);
  if (!claimed.ok) throw new Error(claimed.error.message);
  return { root, ...s, path };
}
type F = ReturnType<typeof fixture>;
const workerLand = (f: F, actor = W1) => land(ws(f.worktree, actor), FAST, quiet);
function redelegate(f: F) { const d = delegate(ws(f.root, OWNER), f.change, "w1", [], quiet); if (!d.ok) throw new Error(d.error.message); }
function accept(f: F) { const a = acceptDesign(ws(f.root, W1), f.change, quiet); if (!a.ok) throw new Error(a.error.message); }
function code(f: F) { put(f.worktree, "app.txt", `worker ${Math.random()}\n`); commit(f.worktree, "code"); }
const refusal = (out: Awaited<ReturnType<typeof land>>) => (out.kind === "refused" ? `${out.reason}: ${out.message}${out.findings?.length ? JSON.stringify(out.findings) : ""}` : out.kind);
function landOks(root: string) {
  const w = ws(root); try { return w.db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'land.ok' ORDER BY id").all().map((r): Record<string, unknown> => ({ subject: r.subject, ...(JSON.parse(r.detail) as Record<string, unknown>) })); } finally { w.db.close(); }
}

test("BR-2501: a worker landing that changes a decision is refused, naming it and both ways to hand it back; main does not move", async () => {
  const f = fixture();
  put(f.worktree, "canon/decisions/D-40.md", read(f.worktree, "canon/decisions/D-40.md") + "\nAnd one more choice.\n"); commit(f.worktree);
  const main = sh(f.root, "rev-parse", "main");
  const out = refusal(await workerLand(f));
  expect(out).toStartWith("delegation: ");
  expect(out).toContain("1. changed design: canon/decisions/D-40.md (D-40)");
  expect(out).toContain(HAND_BACK);
  expect(sh(f.root, "rev-parse", "main")).toBe(main);
}, 60_000);

test("BR-2501: activating a planned contract rule passes; activation plus an example edit, or an edit of its will_amend target, is refused", async () => {
  const ok = fixture({ willAmend: true });
  put(ok.worktree, "canon/rules/task/BR-50.md", read(ok.worktree, "canon/rules/task/BR-50.md").replace("status: planned", "status: active").replace("will_amend: [BR-30]\n", "")); code(ok);
  expect(refusal(await workerLand(ok))).toBe("landed");
  expect(sh(ok.root, "show", "main:canon/rules/task/BR-50.md")).toContain("status: active");

  const example = fixture();
  put(example.worktree, "canon/rules/task/BR-50.md", read(example.worktree, "canon/rules/task/BR-50.md").replace("status: planned", "status: active").replace("- Works.", "- Works well.")); commit(example.worktree);
  const e = refusal(await workerLand(example));
  expect(e).toStartWith("delegation: "); expect(e).toContain("canon/rules/task/BR-50.md (BR-50)");

  const target = fixture({ willAmend: true });
  put(target.worktree, "canon/rules/task/BR-50.md", read(target.worktree, "canon/rules/task/BR-50.md").replace("status: planned", "status: active").replace("will_amend: [BR-30]\n", ""));
  put(target.worktree, "canon/rules/task/BR-30.md", read(target.worktree, "canon/rules/task/BR-30.md").replace("No further reference.", "Amended by the worker."));
  commit(target.worktree);
  const t = refusal(await workerLand(target));
  expect(t).toContain("canon/rules/task/BR-30.md (BR-30)"); expect(t).not.toContain("BR-50.md");
}, 120_000);

test("BR-2501: the change file's two sections written before the delegation land as they are; a worker edit of 要改什么 is refused", async () => {
  const kept = fixture();
  put(kept.worktree, kept.path, read(kept.worktree, kept.path).replace("## 教训\n\n无。", "## 教训\n\n无，worker 写的。")); code(kept);
  expect(refusal(await workerLand(kept))).toBe("landed");

  const edited = fixture();
  put(edited.worktree, edited.path, read(edited.worktree, edited.path).replace("## 要改什么\n\nWorker task.", "## 要改什么\n\nWorker task, and a new design of my own.")); commit(edited.worktree);
  const out = refusal(await workerLand(edited));
  expect(out).toStartWith("delegation: "); expect(out).toContain(`${edited.path} (## 为什么 / ## 要改什么 differ from the task delegated)`);
}, 120_000);

test("BR-2501 BR-2497 BR-2498: a contract item changed on main after the delegation refuses until delegated again and accepted, even with it dropped from rules:", async () => {
  const f = fixture();
  put(f.root, "canon/rules/task/BR-50.md", read(f.root, "canon/rules/task/BR-50.md").replace("Use D-40.", "Use D-40 twice."));
  put(f.root, "docs/DESIGN.md", "# Design\n\nSecond.\n"); commit(f.root, "owner changes the design");
  put(f.worktree, f.path, read(f.worktree, f.path).replace("rules: [BR-50]", "rules: []")); code(f);
  const out = refusal(await workerLand(f));
  expect(out).toStartWith("delegation: ");
  expect(out).toContain("2. design changed since the delegation"); expect(out).toContain("BR-50"); expect(out).toContain("docs/DESIGN.md");
  redelegate(f);
  expect(refusal(await workerLand(f))).toContain("accept-design"); // the claim is still at epoch 1 (BR-2498)
  accept(f);
  expect(refusal(await workerLand(f))).toBe("landed");
}, 120_000);

test("BR-2501 BR-2499: a pending design request on the change refuses, whoever asked it, naming it", async () => {
  const f = fixture();
  const asked = needDesign(ws(f.worktree, W1), f.change, "BR-50 does not say what happens on loss");
  if (!asked.ok) throw new Error(asked.error.message);
  code(f);
  const out = refusal(await workerLand(f));
  expect(out).toStartWith("delegation: "); expect(out).toContain(`3. design requests still pending: #${asked.value.id}`);
}, 60_000);

test("BR-2501: the design scope and design_paths are read from main: deleting design_paths while editing docs/DESIGN.md names both files", async () => {
  const f = fixture();
  put(f.worktree, "canon/config.yaml", read(f.worktree, "canon/config.yaml").replace("design_paths: [docs/DESIGN.md]\n", ""));
  put(f.worktree, "docs/DESIGN.md", "# Design\n\nThe worker's.\n"); commit(f.worktree);
  const out = refusal(await workerLand(f));
  expect(out).toStartWith("delegation: "); expect(out).toContain("canon/config.yaml"); expect(out).toContain("docs/DESIGN.md");
}, 60_000);

test("BR-2501 BR-2497 BR-2498: a landing queued at an epoch voided while it waits is refused even after the worker accepts the new design; landing again checks the new epoch", async () => {
  const f = fixture(); code(f);
  const me = processOf(process.pid)!;
  const w = ws(f.root, "agent:b"); const now = new Date().toISOString();
  const blocker = Number(w.db.db.query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start) VALUES ('/elsewhere', 'C-99', 'landing', ?, ?, ?, ?)").run(now, now, me.pid, me.start).lastInsertRowid);
  const running = workerLand(f);
  for (let i = 0; i < 400 && !w.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(f.worktree); i++) await Bun.sleep(10);
  expect(w.db.db.query<{ epoch: number }, [string]>("SELECT epoch FROM queue WHERE worktree = ?").get(f.worktree)?.epoch).toBe(1);
  redelegate(f); accept(f);
  w.db.db.query("UPDATE queue SET state = 'landed' WHERE id = ?").run(blocker);
  const out = refusal(await running);
  expect(out).toStartWith("delegation: "); expect(out).toContain("4. epoch void: this landing was queued at epoch 1, the delegation is at epoch 2");
  expect(refusal(await workerLand(f))).toBe("landed");
}, 60_000);

test("BR-2501: the epoch is checked again in the transaction that moves main: a redelegation during before_land refuses", async () => {
  // reason: before_land runs after the early check and before main moves, so a redelegation here is caught only by the recheck
  const hook = `CANON_ACTOR=${OWNER} bun ${CLI} work delegate "$CANON_CHANGE" --to w1`;
  const f = fixture({ config: `hooks:\n  before_land: ${JSON.stringify(hook)}\n` });
  code(f);
  const main = sh(f.root, "rev-parse", "main");
  const out = refusal(await workerLand(f));
  expect(out).toStartWith("delegation: "); expect(out).toContain("epoch void"); expect(out).toContain(HAND_BACK);
  expect(sh(f.root, "rev-parse", "main")).toBe(main);
}, 60_000);

test("BR-2501 BR-2503: a worker landing records the delegation snapshot in land.ok; the main session landing the same kind of candidate is not checked and records none", async () => {
  const f = fixture(); code(f);
  const revision = sh(f.root, "rev-parse", "main");
  expect(refusal(await workerLand(f))).toBe("landed");
  const [ok] = landOks(f.root);
  expect(ok).toMatchObject({ subject: f.change, delegation: { lander: W1, epoch: 1, owner: OWNER, revision } });
  expect((ok!.delegation as { contract: { id?: string; path: string }[] }).contract.map((i) => i.id ?? i.path).sort()).toEqual(["BR-50", "D-40", "canon/product.md", "docs/DESIGN.md"].sort());

  const g = startNew(f.root, "Owner's own", OWNER);
  put(g.worktree, "canon/decisions/D-40.md", read(g.worktree, "canon/decisions/D-40.md") + "\nThe owner decides more.\n"); commit(g.worktree);
  expect(refusal(await land(ws(g.worktree, OWNER), FAST, quiet))).toBe("landed");
  expect(landOks(f.root).find((e) => e.subject === g.change)?.delegation).toBeUndefined();
}, 120_000);

test("BR-2501 BR-2458: a worker's chore started before BR-2498 gets item 1 only: a rule edit is refused, code alone lands", async () => {
  for (const [edit, landed] of [[true, false], [false, true]] as const) {
    const root = project(); roots.push(root);
    put(root, "canon/rules/task/BR-30.md", rule("BR-30", "No further reference.", "active")); put(root, "canon/rules/task/README.md", README); put(root, "lib/task.txt", "task\n"); commit(root, "rule");
    const chore = Bun.spawnSync(["bun", CLI, "chore", "start", "tidy"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: OWNER } });
    expect(chore.exitCode).toBe(0);
    const w = ws(root); const c = w.db.db.query<{ subject: string; worktree: string }, []>("SELECT subject, worktree FROM claims").get()!;
    // reason: a worker cannot start a chore since BR-2498; one it started before is this claim
    w.db.db.query("UPDATE claims SET holder = ? WHERE subject = ?").run(W1, c.subject); w.db.close();
    if (edit) put(c.worktree, "canon/rules/task/BR-30.md", read(c.worktree, "canon/rules/task/BR-30.md").replace("No further reference.", "Changed in a chore."));
    put(c.worktree, "app.txt", "chore\n"); commit(c.worktree);
    const out = refusal(await land(ws(c.worktree, W1), FAST, quiet));
    if (landed) expect(out).toBe("landed");
    else { expect(out).toStartWith("delegation: "); expect(out).toContain("canon/rules/task/BR-30.md (BR-30)"); expect(out).not.toContain("epoch"); expect(out).not.toContain("2. "); }
  }
}, 120_000);

test("BR-2501 BR-2022: a worker landing refused by these checks exits 1 through the CLI", () => {
  const f = fixture();
  put(f.worktree, "canon/decisions/D-40.md", read(f.worktree, "canon/decisions/D-40.md") + "\nMore.\n"); commit(f.worktree);
  const r = Bun.spawnSync(["bun", CLI, "work", "land"], { cwd: f.worktree, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: W1 } });
  expect(r.exitCode).toBe(1);
  expect(r.stdout.toString() + r.stderr.toString()).toContain("D-40");
}, 60_000);

/** Lands the worktrees together with their own actors: all queue behind a blocking entry, then it finishes, so the first leads (BR-2172). */
async function landTogether(root: string, landers: readonly { wt: string; actor: string }[]) {
  const other = ws(root, "agent:b"); const now = new Date().toISOString(); const me = processOf(process.pid)!;
  const blocker = Number(other.db.db.query("INSERT INTO queue(worktree, subject, state, enqueued_at, heartbeat, pid, pid_start) VALUES ('/elsewhere', 'C-99', 'landing', ?, ?, ?, ?)").run(now, now, me.pid, me.start).lastInsertRowid);
  const said: string[][] = landers.map(() => []);
  const runs: Promise<Awaited<ReturnType<typeof land>>>[] = [];
  for (const [i, l] of landers.entries()) {
    runs.push(land(ws(l.wt, l.actor), FAST, (m) => said[i]!.push(m)));
    for (let n = 0; n < 400 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(l.wt); n++) await Bun.sleep(10);
  }
  other.db.db.query("UPDATE queue SET state = 'landed' WHERE id = ?").run(blocker);
  return { out: await Promise.all(runs), said };
}

test("BR-2501 BR-2172: in a batch, a worker member is checked on the chain before it: the owner's BR-50 edit ahead lands, the worker's change on the old BR-50 is refused", async () => {
  const f = fixture({ config: "land_batch_max: 3\n" }); code(f);
  const g = startNew(f.root, "Owner edits BR-50", OWNER);
  put(g.worktree, "canon/rules/task/BR-50.md", read(g.worktree, "canon/rules/task/BR-50.md").replace("Use D-40.", "Use D-40 and more.")); commit(g.worktree);
  const { out, said } = await landTogether(f.root, [{ wt: g.worktree, actor: OWNER }, { wt: f.worktree, actor: W1 }]);
  expect(refusal(out[0]!)).toBe("landed");
  expect(said[0]!.join("\n")).toContain("refused in the batch (delegation)");
  const worker = refusal(out[1]!);
  expect(worker).toStartWith("delegation: "); expect(worker).toContain("2. design changed since the delegation"); expect(worker).toContain("BR-50");
}, 120_000);

test("BR-2501 BR-2172: the owner leading a batch is not checked, and a worker member that changed D-40 is refused while the leader lands", async () => {
  const f = fixture({ config: "land_batch_max: 3\n" });
  put(f.worktree, "canon/decisions/D-40.md", read(f.worktree, "canon/decisions/D-40.md") + "\nWorker's choice.\n"); commit(f.worktree);
  const g = startNew(f.root, "Owner's code", OWNER);
  put(g.worktree, "owner.txt", "owner\n"); commit(g.worktree);
  const { out } = await landTogether(f.root, [{ wt: g.worktree, actor: OWNER }, { wt: f.worktree, actor: W1 }]);
  expect(refusal(out[0]!)).toBe("landed");
  const worker = refusal(out[1]!);
  expect(worker).toStartWith("delegation: "); expect(worker).toContain("canon/decisions/D-40.md (D-40)");
}, 120_000);
