import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../testkit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const rule = (id: string, body = "Use D-40 and BR-51.", status = "planned") => `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nbusiness: dispatch\n---\n\n## 规则\n\n${body}\n\n## 例子\n\n- Works.\n`;
function put(root: string, path: string, text: string) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
function commit(root: string) { sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture"); }
function cli(root: string, actor: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../invocation/main.ts"), ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
function fixture(firstRule = rule("BR-50")) {
  const root = project(); roots.push(root);
  put(root, "canon/product.md", "# Product\n\nShared work.\n");
  put(root, "canon/rules/task/BR-50.md", firstRule);
  put(root, "canon/rules/task/BR-51.md", rule("BR-51", "Use BR-52."));
  put(root, "canon/rules/task/BR-52.md", rule("BR-52", "No further reference."));
  put(root, "canon/decisions/D-40.md", "---\nid: D-40\ntitle: Contract\nstatus: accepted\n---\n\n## 决定\n\nUse a contract.\n");
  commit(root);
  const started = startNew(root, "Delegated implementation", "agent:s1");
  const changePath = `canon/changes/${readdirSync(join(started.worktree, "canon/changes")).find((p) => p.startsWith(`${started.change}-`) || p === `${started.change}.md`)!}`;
  const file = join(started.worktree, changePath);
  writeFileSync(file, readFileSync(file, "utf8").replace(/rules: \[\]/, "rules: [BR-50]")); commit(started.worktree);
  return { root, ...started, changePath };
}
function dispatch(root: string, change: string, actor = "agent:s1", name = "w1", extra: string[] = []) { return cli(root, actor, "work", "delegate", change, "--to", name, ...extra); }
function record(root: string, change: string) {
  const w = ws(root); try { const r = w.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE subject = ? AND kind LIKE 'delegation.%' ORDER BY id DESC LIMIT 1").get(change); return r ? JSON.parse(r.detail) : undefined; } finally { w.db.close(); }
}

test("BR-2497: dispatch pins main, one-level references and committed task, releasing only its owner's claim", () => {
  const f = fixture();
  const revision = sh(f.root, "rev-parse", "main");
  put(f.worktree, f.changePath, readFileSync(join(f.worktree, f.changePath), "utf8") + "\nUncommitted note.\n");
  const r = dispatch(f.root, f.change); expect(r.code).toBe(0); expect(r.text).toContain("design-gap review: not configured");
  const d = record(f.root, f.change); expect(d).toMatchObject({ worker: "w1", owner: "agent:s1", revision, epoch: 1, acceptor: null });
  expect(d.manifest.map((x: { path: string }) => x.path).sort()).toEqual(["canon/product.md", "canon/rules/task/BR-50.md", "canon/rules/task/BR-51.md", "canon/decisions/D-40.md"].sort());
  expect(d.manifest.find((x: { id: string }) => x.id === "BR-50").hash).toBe(hash(readFileSync(join(f.root, "canon/rules/task/BR-50.md"), "utf8")));
  expect(d.taskHash).toBe(hash(JSON.stringify(["\nDelegated implementation.\n", "\nDelegated implementation.\n"])));
  const w = ws(f.root); expect(w.db.db.query("SELECT 1 FROM claims WHERE subject = ?").get(f.change)).toBeNull(); w.db.close();
  expect(existsSync(f.worktree)).toBe(true);
});

test("BR-2497: will_amend targets are contracts, code references are examples, and activation may delete only will_amend", () => {
  const text = rule("BR-50", "Use D-40. Example `BR-51`.").replace("business: dispatch\n", "business: dispatch\nwill_amend: [BR-52]\n");
  const f = fixture(text);
  put(f.worktree, "canon/rules/task/BR-50.md", text.replace("status: planned", "status: active").replace("will_amend: [BR-52]\n", "")); commit(f.worktree);
  expect(dispatch(f.root, f.change).code).toBe(0);
  const ids = record(f.root, f.change).manifest.map((i: { id?: string }) => i.id); expect(ids).toContain("BR-52"); expect(ids).not.toContain("BR-51");
});

test("BR-2497: unpublished rules, branch rule edits and product edits refuse without a dispatch or claim change", () => {
  for (const path of ["canon/rules/task/BR-50.md", "canon/product.md", "canon/rules/task/BR-51.md"]) {
    const f = fixture(); put(f.worktree, path, readFileSync(join(f.worktree, path), "utf8") + "\nChanged.\n"); commit(f.worktree);
    const r = dispatch(f.root, f.change); expect(r.code).toBe(1); expect(r.text).toContain(path); expect(record(f.root, f.change)).toBeUndefined();
    const w = ws(f.root); expect(w.db.db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(f.change)?.holder).toBe("agent:s1"); w.db.close();
  }
  const f = fixture(); put(f.worktree, "canon/rules/task/BR-60.md", rule("BR-60"));
  const file = join(f.worktree, f.changePath); writeFileSync(file, readFileSync(file, "utf8").replace("[BR-50]", "[BR-50, BR-60]")); commit(f.worktree);
  const r = dispatch(f.root, f.change); expect(r.code).toBe(1); expect(r.text).toContain("BR-60"); expect(record(f.root, f.change)).toBeUndefined();
});

test("BR-2497: main advancing is allowed and only mechanical activation is exempt", () => {
  const f = fixture();
  put(f.root, "canon/rules/task/BR-50.md", rule("BR-50", "New design uses D-40.")); commit(f.root);
  let r = dispatch(f.root, f.change); expect(r.code).toBe(0); expect(record(f.root, f.change).revision).toBe(sh(f.root, "rev-parse", "main"));
  put(f.worktree, "canon/rules/task/BR-50.md", rule("BR-50", "Use D-40 and BR-51.", "active")); commit(f.worktree);
  r = dispatch(f.root, f.change); expect(r.code).toBe(0); expect(record(f.root, f.change).epoch).toBe(2);
  put(f.worktree, "canon/rules/task/BR-50.md", rule("BR-50", "Changed design.", "active")); commit(f.worktree);
  r = dispatch(f.root, f.change); expect(r.code).toBe(1); expect(record(f.root, f.change).epoch).toBe(2);
});

test("BR-2497: main design_paths and explicit contract lists are pinned and checked", () => {
  const f = fixture(); put(f.root, "design.txt", "Architecture\n"); put(f.root, "extra.txt", "Extra\n");
  put(f.root, "canon/config.yaml", readFileSync(join(f.root, "canon/config.yaml"), "utf8") + "design_paths: [design.txt]\n"); commit(f.root);
  const r = dispatch(f.root, f.change, "agent:s1", "w1", ["--contract", "extra.txt,BR-52"]); expect(r).toMatchObject({ code: 0 });
  const paths = record(f.root, f.change).manifest.map((x: { path: string }) => x.path); expect(paths).toContain("design.txt"); expect(paths).toContain("extra.txt"); expect(paths).toContain("canon/rules/task/BR-52.md");
  put(f.worktree, "extra.txt", "Changed\n"); commit(f.worktree);
  expect(dispatch(f.root, f.change, "agent:s1", "w1", ["--contract", "extra.txt"]).code).toBe(1);
});

test("BR-2497: empty or duplicate explicit contract items and repeated options are usage errors", () => {
  const f = fixture();
  for (const value of ["", ",BR-50", "BR-50,", "BR-50,,BR-51", "BR-50,BR-50"]) {
    expect(dispatch(f.root, f.change, "agent:s1", "w1", ["--contract", value]).code).toBe(2);
    expect(record(f.root, f.change)).toBeUndefined();
  }
  expect(dispatch(f.root, f.change, "agent:s1", "w1", ["--contract", "BR-50", "--contract", "BR-51"]).code).toBe(2);
});

test("BR-2497: a quoted configured code-review command suppresses the missing-review notice", () => {
  const f = fixture(); put(f.root, "scripts/code-review.ts", "export {};\n");
  put(f.root, "canon/config.yaml", readFileSync(join(f.root, "canon/config.yaml"), "utf8") + "hooks:\n  after_land: bun 'scripts/code-review.ts'\n"); commit(f.root);
  const r = dispatch(f.root, f.change); expect(r).toMatchObject({ code: 0 }); expect(r.text).not.toContain("design-gap review: not configured");
});

test("BR-2497: redelegation keeps an active acceptor, refuses renaming it and clears it after takeover", () => {
  const f = fixture(); expect(dispatch(f.root, f.change).code).toBe(0);
  const w = ws(f.root); w.db.db.query("UPDATE delegations SET acceptor = ? WHERE subject = ?").run("agent:s7:w1", f.change);
  w.db.db.query("INSERT INTO claims(subject,holder,worktree,expires_at,delegation_epoch) VALUES (?,?,?,?,?)").run(f.change, "agent:s7:w1", f.worktree, "2099-01-01", 1); w.db.close();
  expect(dispatch(f.root, f.change).code).toBe(0); expect(record(f.root, f.change)).toMatchObject({ epoch: 2, acceptor: "agent:s7:w1" });
  expect(dispatch(f.root, f.change, "agent:s1", "w2").code).toBe(5); expect(record(f.root, f.change).epoch).toBe(2);
  const w2 = ws(f.root); w2.db.db.query("UPDATE claims SET holder = ? WHERE subject = ?").run("agent:s1", f.change); w2.db.close();
  expect(dispatch(f.root, f.change).code).toBe(0); expect(record(f.root, f.change)).toMatchObject({ epoch: 3, acceptor: null });
  expect(dispatch(f.root, f.change, "agent:s2", "w2").code).toBe(0);
  expect(record(f.root, f.change)).toMatchObject({ epoch: 4, owner: "agent:s2", worker: "w2", previous: { owner: "agent:s1", worker: "w1", epoch: 3 } });
});

test("BR-2497: invalid actors, names, missing or closed changes and other primary holders refuse", () => {
  const f = fixture();
  for (const actor of ["agent:s1:w1", "agent:unknown"]) expect(dispatch(f.root, f.change, actor).code).toBe(2);
  expect(dispatch(f.root, f.change, "agent:s1", "w 1").code).toBe(2);
  expect(dispatch(f.root, "C-404").code).toBe(3);
  expect(dispatch(f.root, f.change, "agent:s2").code).toBe(5);
  const file = join(f.worktree, f.changePath); writeFileSync(file, readFileSync(file, "utf8").replace("status: open", "status: done")); commit(f.worktree);
  expect(dispatch(f.root, f.change).code).toBe(3); expect(record(f.root, f.change)).toBeUndefined();
});
