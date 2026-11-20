import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws, quiet, startNew, waitFor } from "../testkit.ts";
import { startChore } from "./session.ts";
import { land } from "../land/land.ts";
import { enqueue, finishEntry } from "../land/queue/queue.ts";
import { checkCommand } from "../claims/as-check.ts";

const main = join(import.meta.dir, "../../invocation/main.ts");
function cli(root: string, ...args: string[]) {
  return Bun.spawnSync(["bun", main, ...args], { cwd: root, env: { ...process.env, CANON_ACTOR: "agent:chore-test" }, stdout: "pipe", stderr: "pipe" });
}

test("BR-2457: chore CLI creates independent work without consuming a change number", () => {
  const root = project();
  const before = sh(root, "rev-parse", "main");
  const a = cli(root, "chore", "start", "update tools");
  expect(a.exitCode).toBe(0);
  const match = a.stdout.toString().match(/(chore-[0-9a-f-]+) → (.+) \(branch (.+)\)/)!;
  expect(match).not.toBeNull();
  const [, subject, wt, branch] = match;
  expect(existsSync(join(wt!, "canon/changes"))).toBe(false);
  expect(sh(wt!, "rev-parse", "HEAD")).toBe(before);
  expect(branch).toStartWith("chore/");
  expect(a.stdout.toString()).toContain(`${subject} is a light change: its change file and C number are written when it lands (canon chore land)`);
  const b = cli(root, "chore", "start", "update tools");
  expect(b.exitCode).toBe(0);
  expect(b.stdout.toString()).not.toContain(subject!);
  expect(ws(root).db.db.query("SELECT * FROM ids WHERE prefix = 'C'").all()).toEqual([]);
});

test("BR-2457: empty titles fail before creating work", () => {
  const root = project();
  const out = cli(root, "chore", "start", " ");
  expect(out.exitCode).toBe(2);
  expect(sh(root, "for-each-ref", "--format=%(refname)", "refs/heads/chore/")).toBe("");
});

test("BR-2458 BR-2457: chore CLI lands through the shared floor with its light change file in its close commit, and no open commit", () => {
  const root = project();
  const out = cli(root, "chore", "start", "edit app");
  expect(out.exitCode).toBe(0);
  const [, subject, wt] = out.stdout.toString().match(/(chore-[0-9a-f-]+) → (.+) \(branch /)!;
  writeFileSync(join(wt!, "app.txt"), "updated\n");
  sh(wt!, "commit", "-qam", "update app");
  const landed = cli(wt!, "chore", "land");
  expect(landed.exitCode).toBe(0);
  expect(sh(root, "show", "main:app.txt")).toBe("updated");
  expect(sh(root, "log", "-1", "--format=%s", "main")).toBe(`canon: close ${subject}`);
  expect(sh(root, "log", "-1", "--format=%b", "main")).toBe("C-1 edit app");
  expect(sh(root, "log", "-1", "--format=%s", "main~1")).toBe("update app");
  expect(sh(root, "log", "--format=%s", "main")).not.toContain("canon: open");
  expect(sh(root, "diff", "--name-status", "main~1", "main")).toBe("A\tcanon/changes/C-1-edit-app.md");
  const file = sh(root, "show", "main:canon/changes/C-1-edit-app.md");
  for (const line of ["id: C-1", "title: edit app", "status: done", "rules: []", `chore: ${subject}`]) expect(file).toContain(line);
  expect(landed.stdout.toString() + landed.stderr.toString()).toContain(`${subject} completed as C-1`);
  expect(ws(root).db.db.query("SELECT * FROM claims WHERE subject = ?").all(subject!)).toEqual([]);
  const check = cli(root, "check");
  expect([check.exitCode, check.stdout.toString() + check.stderr.toString()]).toEqual([0, expect.not.stringContaining("C-1")]);
});

function started(root: string, title = "maintenance") {
  const r = cli(root, "chore", "start", title);
  expect(r.exitCode).toBe(0);
  const m = r.stdout.toString().match(/(chore-[0-9a-f-]+) → (.+) \(branch (.+)\)/)!;
  return { subject: m[1]!, worktree: m[2]!, branch: m[3]! };
}

test("BR-2457: released chores resume from their branch without documents or events", () => {
  const root = project();
  const a = started(root);
  const stopped = cli(a.worktree, "work", "stop", "--reason", "partial", "--next", "continue tooling", "--release");
  expect(stopped.exitCode).toBe(0);
  expect(stopped.stdout.toString()).not.toContain("## 教训");
  const brief = cli(a.worktree, "brief");
  expect(brief.stdout.toString()).toContain(a.subject);
  expect(brief.stdout.toString()).toContain("continue tooling");
  expect(brief.stdout.toString()).not.toContain(`canon show ${a.subject}`);
  const db = ws(root).db;
  db.db.query("DELETE FROM handoffs WHERE subject = ?").run(a.subject);
  db.db.query("DELETE FROM events WHERE subject = ?").run(a.subject);
  sh(root, "worktree", "remove", a.worktree);
  const again = cli(root, "chore", "start", a.subject.toUpperCase());
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain(a.branch);
  expect(again.stdout.toString()).toContain("full title unavailable");
  expect(sh(a.worktree, "rev-parse", "HEAD")).toBe(sh(root, "rev-parse", "main"));
});

test("BR-2457: duplicate branch identities and mismatching claims refuse without taking work", () => {
  const root = project();
  const missing = cli(root, "chore", "start", "chore-00000000-0000-4000-8000-000000000000");
  expect([missing.exitCode, missing.stderr.toString()]).toEqual([3, expect.stringContaining("no chore branch")]);
  const a = started(root);
  expect(cli(a.worktree, "work", "stop", "--reason", "partial", "--next", "continue", "--release").exitCode).toBe(0);
  const duplicate = `chore/${a.subject.slice(6)}-duplicate`;
  sh(root, "branch", duplicate, "main");
  const ambiguous = cli(root, "chore", "start", a.subject);
  expect(ambiguous.exitCode).toBe(5);
  expect(ambiguous.stderr.toString()).toContain("more than one branch");
  sh(root, "branch", "-D", duplicate);
  const other = started(root, "other");
  ws(root).db.db.query("UPDATE claims SET worktree = ? WHERE subject = ?").run(a.worktree, other.subject);
  const mismatch = cli(root, "chore", "start", a.subject);
  expect(mismatch.exitCode).toBe(5);
  expect(mismatch.stderr.toString()).toContain("identity");
});

test("BR-2457: setup failure and unknown options leave no work behind", () => {
  const root = project();
  expect(cli(root, "chore", "start", "x", "--unknown").exitCode).toBe(2);
  writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\nsetup: "false"\n');
  sh(root, "commit", "-qam", "failing setup");
  const out = cli(root, "chore", "start", "setup fails");
  expect(out.exitCode).toBe(1);
  expect(out.stderr.toString()).toContain("setup command");
  expect(sh(root, "for-each-ref", "--format=%(refname)", "refs/heads/chore/")).toBe("");
  expect(ws(root).db.db.query("SELECT * FROM claims").all()).toEqual([]);
});

test("BR-2458 BR-2457: a chore dropped after a refused landing leaves nothing on main and no change in the list", () => {
  const root = project();
  const a = started(root, "abandoned work");
  writeFileSync(join(a.worktree, "FAIL"), "x\n");
  sh(a.worktree, "add", "FAIL");
  sh(a.worktree, "commit", "-qm", "floor fails");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(1);
  expect(cli(a.worktree, "work", "stop", "--reason", "partial", "--next", "abandoned", "--release").exitCode).toBe(0);
  expect(cli(root, "work", "drop", a.subject).exitCode).toBe(0);
  expect(sh(root, "ls-tree", "-r", "--name-only", "main")).not.toContain("canon/changes");
  const list = cli(root, "change", "list");
  expect([list.exitCode, list.stdout.toString()]).toEqual([0, expect.not.stringContaining("abandoned")]);
});

test("BR-2458 BR-2457: a chore whose recorded title is gone lands with the branch slug as its title and says so", () => {
  const root = project();
  const a = started(root, "tidy readme");
  writeFileSync(join(a.worktree, "app.txt"), "tidy\n");
  sh(a.worktree, "commit", "-qam", "tidy");
  ws(root).db.db.query("DELETE FROM events WHERE kind = 'chore.start' AND subject = ?").run(a.subject);
  const landed = cli(a.worktree, "chore", "land");
  expect(landed.exitCode).toBe(0);
  expect(landed.stdout.toString() + landed.stderr.toString()).toContain(`${a.subject}: full title unavailable; the change file takes the branch slug as its title`);
  expect(sh(root, "show", "main:canon/changes/C-1-tidy-readme.md")).toContain("title: tidy-readme");
});

test("BR-2458 BR-2091: a light change file needs no sections, a change without chore: still does, and a chore: that is no chore identity is file-invalid", () => {
  const root = project();
  mkdirSync(join(root, "canon/changes"), { recursive: true });
  const file = (n: number, extra: string) => writeFileSync(join(root, `canon/changes/C-${n}.md`), `---\nid: C-${n}\ntitle: t${n}\nstatus: done\nrules: []\n${extra}---\n`);
  file(1, "chore: chore-0b0e3f4a-1111-4222-8333-944445555666\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "light change");
  const ok = cli(root, "check");
  expect([ok.exitCode, ok.stdout.toString() + ok.stderr.toString()]).toEqual([0, expect.not.stringContaining("C-1")]);
  file(2, "");
  file(3, "chore: abc\n");
  const bad = cli(root, "check");
  const out = bad.stdout.toString() + bad.stderr.toString();
  expect(bad.exitCode).toBe(1);
  expect(out).toMatch(/doc-missing-section\s+canon\/changes\/C-2\.md/);
  expect(out).toMatch(/file-invalid\s+canon\/changes\/C-3\.md: .*`chore`/);
  expect(out).not.toMatch(/canon\/changes\/C-1\.md/);
});

test("BR-2458: clean keeps an unfinished empty chore and drop archives unpublished work", () => {
  const root = project();
  const a = started(root);
  expect(cli(a.worktree, "work", "stop", "--reason", "partial", "--next", "later", "--release").exitCode).toBe(0);
  const clean = cli(root, "work", "clean", a.subject);
  expect(clean.exitCode).toBe(0);
  expect(existsSync(a.worktree)).toBe(true);
  writeFileSync(join(a.worktree, "app.txt"), "unpublished\n");
  const drop = cli(root, "work", "drop", a.subject);
  expect(drop.exitCode).toBe(0);
  expect(existsSync(a.worktree)).toBe(false);
  const archive = sh(root, "for-each-ref", "--format=%(refname)", `refs/canon/archive/${a.subject}/`);
  expect(sh(root, "show", `${archive}:app.txt`)).toBe("unpublished");
});

test("BR-2458: floor and document violations keep main unchanged and allow a retry", () => {
  const root = project();
  const a = started(root);
  const before = sh(root, "rev-parse", "main");
  writeFileSync(join(a.worktree, "FAIL"), "x\n");
  sh(a.worktree, "add", "FAIL");
  sh(a.worktree, "commit", "-qm", "floor fails");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(1);
  expect(sh(root, "rev-parse", "main")).toBe(before);
  expect(existsSync(join(a.worktree, "canon/changes"))).toBe(false); // the close commit was taken back with its file
  expect(sh(a.worktree, "log", "-1", "--format=%s")).toBe("floor fails");
  startNew(root, "business change takes the next number"); // C-2: the chore keeps C-1 for its next landing
  sh(a.worktree, "rm", "FAIL");
  sh(a.worktree, "commit", "-qm", "fix floor");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(0);
  expect(sh(root, "ls-tree", "--name-only", "main", "canon/changes/")).toBe("canon/changes/C-1-maintenance.md");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(0);
  expect(ws(root).db.db.query("SELECT * FROM events WHERE kind = 'land.ok' AND subject = ?").all(a.subject)).toHaveLength(1);
});

test("BR-2458: a chore deleting config retries with the current custom main floor", () => {
  const root = project();
  sh(root, "branch", "-m", "trunk");
  writeFileSync(join(root, "canon/config.yaml"), 'main: trunk\nfloor: "test ! -e FAIL"\ntests: []\nreview: none\n');
  sh(root, "commit", "-qam", "custom main");
  const a = started(root);
  sh(a.worktree, "rm", "canon/config.yaml");
  writeFileSync(join(a.worktree, "FAIL"), "x\n");
  sh(a.worktree, "add", "FAIL");
  sh(a.worktree, "commit", "-qm", "remove config");
  const failed = cli(a.worktree, "chore", "land");
  expect([failed.exitCode, failed.stderr.toString()]).toEqual([1, expect.stringContaining("floor")]);
  expect(failed.stderr.toString()).toContain("floor");
  sh(a.worktree, "rm", "FAIL");
  sh(a.worktree, "commit", "-qm", "repair");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(0);
  expect(sh(root, "log", "-1", "--format=%s", "trunk~1")).toBe("repair");
});

test("BR-2458 BR-2199: released work cannot land anonymously and hook identity survives after landing", () => {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\nhooks:\n  before_land: 'test "$CANON_KIND" = chore && test -z "$CANON_CHANGE" && test -n "$CANON_SUBJECT"'\n  after_land: "true"\n`);
  sh(root, "commit", "-qam", "hooks");
  const a = started(root);
  expect(cli(a.worktree, "work", "stop", "--reason", "partial", "--next", "later", "--release").exitCode).toBe(0);
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(2);
  expect(ws(root).db.db.query("SELECT * FROM queue").all()).toEqual([]);
  expect(cli(root, "chore", "start", a.subject).exitCode).toBe(0);
  sh(a.worktree, "commit", "--allow-empty", "-qm", "record maintenance");
  expect(cli(a.worktree, "chore", "land").exitCode).toBe(0);
  const after = cli(root, "work", "after-land", a.subject, "--wait");
  expect(after.exitCode).toBe(0);
  expect(after.stdout.toString()).toContain(a.subject);
});

test("BR-2458: valid active rule edits are allowed but planned activation still needs a Change", () => {
  const root = project();
  mkdirSync(join(root, "canon/rules/demo"), { recursive: true });
  mkdirSync(join(root, "src/demo"), { recursive: true });
  writeFileSync(join(root, "src/demo/app.ts"), "export const ready = true;\n");
  writeFileSync(join(root, "canon/rules/demo/README.md"), "---\ncode: [src/demo]\n---\n# Demo\n\n规则示例。\n\n## 业务\n\n- **输入**：输入的处理。\n\n## 术语\n\n- **输入**：待处理的值。\n");
  const rule = (status: string, text: string) => `---\nid: BR-1\ntitle: 示例\nstatus: ${status}\nbusiness: 输入\nuntested: 第三方保证\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- 输入 → 输出\n`;
  writeFileSync(join(root, "canon/rules/demo/BR-1.md"), rule("active", "允许输入。"));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "rule fixture");
  const a = started(root);
  writeFileSync(join(a.worktree, "canon/rules/demo/BR-1.md"), rule("active", "检查输入。"));
  sh(a.worktree, "commit", "-qam", "edit active rule");
  const allowed = cli(a.worktree, "chore", "land");
  expect([allowed.exitCode, allowed.stderr.toString()]).toEqual([0, expect.any(String)]);
  writeFileSync(join(root, "canon/rules/demo/BR-1.md"), rule("planned", "检查输入。"));
  sh(root, "commit", "-qam", "planned fixture");
  const b = started(root, "activation");
  writeFileSync(join(b.worktree, "canon/rules/demo/BR-1.md"), rule("active", "检查输入。"));
  sh(b.worktree, "commit", "-qam", "attempt activation");
  const refused = cli(b.worktree, "chore", "land");
  expect([refused.exitCode, refused.stderr.toString()]).toEqual([1, expect.stringContaining("activate")]);
  expect(sh(root, "show", "main:canon/rules/demo/BR-1.md")).toContain("status: planned");
});

test("BR-2172 BR-2278: a landing that deletes canon/config.yaml is never batched with other work", async () => {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), 'floor: "test ! -e FAIL"\ntests: []\nreview: none\nland_batch_max: 3\n');
  sh(root, "commit", "-qam", "batch config");
  const leader = startNew(root, "business leader");
  writeFileSync(join(leader.worktree, "feature.txt"), "feature\n");
  sh(leader.worktree, "add", "feature.txt");
  sh(leader.worktree, "commit", "-qm", "feature");
  const uninstallLike = startChore(ws(root), { title: "remove config" }, quiet);
  if (!uninstallLike.ok) throw new Error(uninstallLike.error.message);
  sh(uninstallLike.value.worktree, "rm", "-q", "canon/config.yaml");
  sh(uninstallLike.value.worktree, "commit", "-qm", "remove config");
  const db = ws(root).db;
  const blocker = enqueue(db, "/blocker", "C-99", "agent:blocker");
  const pending = [land(ws(leader.worktree), { finish: true, timeoutMs: 20000 }, quiet)];
  await waitFor("leader queues", () => !!db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(leader.worktree));
  pending.push(land(ws(uninstallLike.value.worktree), { finish: true, timeoutMs: 20000 }, quiet));
  await waitFor("config-deleting chore queues", () => !!db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(uninstallLike.value.worktree));
  finishEntry(db, blocker, "landed", "x");
  const outcomes = await Promise.all(pending);
  expect(outcomes.map((o) => o.kind)).toEqual(["landed", "landed"]);
  expect(db.db.query("SELECT * FROM events WHERE kind = 'batch.start'").all()).toEqual([]);
  expect(sh(root, "show", "main:feature.txt")).toBe("feature");
  expect(sh(root, "ls-tree", "--name-only", "main", "canon/config.yaml")).toBe("");
});

test("BR-2340: chore claim commands retain the subagent identity guard", () => {
  for (const command of ['canon chore start "tools"', "canon chore land"]) {
    expect(checkCommand(command, "worker").kind).toBe("deny");
    expect(checkCommand(`${command} --as worker`, "worker").kind).toBe("allow");
    expect(checkCommand(`${command} --as worker`, undefined).kind).toBe("deny");
  }
});

for (const choreFirst of [true, false]) test(`BR-2458: mixed batches keep each member identity with choreFirst=${choreFirst}`, async () => {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), 'floor: "test ! -e FAIL"\ntests: []\nreview: none\nland_batch_max: 3\n');
  sh(root, "commit", "-qam", "batch config");
  const c = startChore(ws(root), { title: "tooling" }, quiet);
  if (!c.ok) throw new Error(c.error.message);
  const b = startNew(root, "business");
  for (const [work, file] of [[c.value, "tool.txt"], [b, "feature.txt"]] as const) {
    writeFileSync(join(work.worktree, file), file);
    sh(work.worktree, "add", file);
    sh(work.worktree, "commit", "-qm", file);
  }
  const db = ws(root).db;
  const blocker = enqueue(db, "/blocker", "C-99", "agent:blocker");
  const ordered = choreFirst ? [c.value, b] : [b, c.value];
  const pending = [];
  for (const work of ordered) {
    pending.push(land(ws(work.worktree), { finish: true, timeoutMs: 20000 }, quiet));
    await waitFor("member queues", () => !!db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(work.worktree));
  }
  finishEntry(db, blocker, "landed", "x");
  const outcomes = await Promise.all(pending);
  expect(outcomes.map((o) => o.kind)).toEqual(["landed", "landed"]);
  expect(sh(root, "show", "main:tool.txt")).toBe("tool.txt");
  expect(sh(root, "show", "main:feature.txt")).toBe("feature.txt");
  expect(db.db.query("SELECT * FROM claims WHERE subject IN (?, ?)").all(c.value.change, b.change)).toEqual([]);
  expect(db.db.query("SELECT * FROM events WHERE kind = 'batch.start'").all()).toHaveLength(1);
});
