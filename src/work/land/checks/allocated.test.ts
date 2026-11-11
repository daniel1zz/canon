import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew, ws } from "../../testkit.ts";

// reason: these tests drive a spawned `canon work land`, which waits on queue polls (C-111).
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../../invocation/main.ts");

async function canonIn(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

// Ids are assembled at runtime so this file does not itself name rules when canon check scans the repo.
const rid = (n: number) => ["BR", n].join("-");
const did = (n: number) => ["D", n].join("-");
const rule = (n: number, text = "Rule text.") => `---\nid: ${rid(n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\nbusiness: x\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n`;
const decision = (n: number) => `---\nid: ${did(n)}\ntitle: Pick ${n}\nstatus: proposed\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n   - 来源：refund.txt “export function refund(order)”\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;

const write = (wt: string, path: string, text: string) => {
  mkdirSync(join(wt, path, ".."), { recursive: true });
  writeFileSync(join(wt, path), text);
};
const commit = (wt: string) => {
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "docs");
};
const readme = (name: string) => `---\nname: ${name}\ncode: [refund.txt]\n---\n# ${name}\n\nOne domain.\n\n## 术语\n\n- **x**：y。\n\n## 业务\n\n- **x**：y\n`;
const withDomain = (wt: string) => {
  write(wt, "refund.txt", "export function refund(order) {}\n");
  write(wt, "canon/rules/shop/README.md", readme("shop"));
};
/** Allocates `prefix-n` in `where`, as `canon rule new` run there would. */
const allocateIn = (where: string, prefix: string, n: number) => {
  const id = ws(where).db.allocate(prefix, n - 1, "agent:a");
  expect(id).toBe(`${prefix}-${n}`);
};

describe("a landing that adds an id allocated to another change's worktree is refused", () => {
  test("BR-2362: an id allocated in this change's own worktree passes", async () => {
    const root = project();
    const s = startNew(root, "Own");
    allocateIn(s.worktree, "BR", 501);
    withDomain(s.worktree);
    write(s.worktree, `canon/rules/shop/${rid(501)}.md`, rule(501));
    commit(s.worktree);
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.err + r.out).not.toContain("allocated");
    expect(r.code).toBe(0);
  }, TIMED);

  test("BR-2362: a hand-written rule id allocated in another change's worktree exits 1 naming the id and that change, and main does not move", async () => {
    const root = project();
    const other = startNew(root, "Holder");
    const s = startNew(root, "Lander");
    allocateIn(other.worktree, "BR", 501);
    withDomain(s.worktree);
    write(s.worktree, `canon/rules/shop/${rid(501)}.md`, rule(501));
    commit(s.worktree);
    const before = sh(root, "rev-parse", "main");
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(1);
    const text = r.err + r.out;
    expect(text).toContain(rid(501));
    expect(text).toContain(other.change);
    expect(text).toContain("canon rule new");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    const refused = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse'").all();
    expect(refused.map((e) => (JSON.parse(e.detail) as { reason: string }).reason)).toEqual(["check"]);
  }, TIMED);

  test("BR-2362: a hand-written decision id allocated in another change's worktree exits 1 and says to use canon decision new", async () => {
    const root = project();
    const other = startNew(root, "Holder");
    const s = startNew(root, "Lander");
    allocateIn(other.worktree, "D", 90);
    write(s.worktree, "refund.txt", "export function refund(order) {}\n");
    write(s.worktree, `canon/decisions/${did(90)}.md`, decision(90));
    commit(s.worktree);
    const r = await canonIn(s.worktree, "work", "land");
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain(did(90));
    expect(r.err + r.out).toContain("canon decision new");
  }, TIMED);

  test("BR-2362: an id allocated in the primary checkout passes", async () => {
    const root = project();
    const s = startNew(root, "From primary");
    allocateIn(root, "BR", 501);
    withDomain(s.worktree);
    write(s.worktree, `canon/rules/shop/${rid(501)}.md`, rule(501));
    commit(s.worktree);
    expect((await canonIn(s.worktree, "work", "land")).code).toBe(0);
  }, TIMED);

  test("BR-2362: an id with no allocation record passes", async () => {
    const root = project();
    const s = startNew(root, "Hand written");
    withDomain(s.worktree);
    write(s.worktree, `canon/rules/shop/${rid(777)}.md`, rule(777));
    commit(s.worktree);
    expect((await canonIn(s.worktree, "work", "land")).code).toBe(0);
  }, TIMED);

  test("BR-2362: a rule moved to another directory keeps its id and passes though another worktree holds the allocation, and an edit of a rule on main is not checked", async () => {
    const root = project();
    const first = startNew(root, "Adds");
    withDomain(first.worktree);
    write(first.worktree, `canon/rules/shop/${rid(7)}.md`, rule(7));
    commit(first.worktree);
    expect((await canonIn(first.worktree, "work", "land")).code).toBe(0);
    const other = startNew(root, "Holder");
    allocateIn(other.worktree, "BR", 7);
    const move = startNew(root, "Moves");
    write(move.worktree, "canon/rules/store/README.md", readme("store"));
    renameSync(join(move.worktree, `canon/rules/shop/${rid(7)}.md`), join(move.worktree, `canon/rules/store/${rid(7)}.md`));
    commit(move.worktree);
    const r = await canonIn(move.worktree, "work", "land");
    expect(r.err + r.out).not.toContain("allocated");
    const edit = startNew(root, "Edits");
    write(edit.worktree, `canon/rules/store/${rid(7)}.md`, rule(7, "Reworded rule text."));
    commit(edit.worktree);
    expect((await canonIn(edit.worktree, "work", "land")).err).not.toContain("allocated");
  }, TIMED * 3);
});
