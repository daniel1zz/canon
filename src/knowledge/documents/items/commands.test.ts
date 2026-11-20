import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh } from "../../../work/testkit.ts";

/** `canon check`'s item notes and findings (BR-2549) and `canon show --json` (BR-2550), through the real command line. */

// reason: several cases spawn canon in a temporary repository, which is slow on a loaded machine (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "..", "invocation", "main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const CHANGE = (n: number, lessons: string) =>
  `---\nid: ${id("C", n)}\ntitle: Test change\nrules: []\n---\n\n## 为什么\n\nWhy.\n\n## 要改什么\n\nWhat.\n\n## 教训\n\n${lessons}\n`;

/** Writes a document, making the directory the project's fixture does not have. */
function writeDoc(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A linked worktree on a change branch off main, as `canon work start` makes one. */
function worktreeOf(root: string): string {
  const wt = join(mkdtempSync(join(tmpdir(), "canon-items-wt-")), "wt");
  sh(root, "worktree", "add", "-q", "-b", `change/${id("C", 9)}`, wt);
  return wt;
}

describe("canon check reads items", () => {
  test("BR-2549: a lesson this work wrote that lacks dest is a note on stderr, and the exit code does not change", () => {
    const root = project();
    const wt = worktreeOf(root);
    writeDoc(wt, `canon/changes/${id("C", 9)}.md`, CHANGE(9, "- 只写了一句话"));
    const r = canon(wt, "check");
    expect(r.err).toContain(`note: canon/changes/${id("C", 9)}.md: 教训 item "只写了一句话" lacks dest (BR-2549)`);
    expect(r.code).toBe(0);
  });

  test("BR-2549: the same lesson in a change this work did not change gets no note", () => {
    const root = project();
    writeDoc(root, `canon/changes/${id("C", 8)}.md`, CHANGE(8, "- 只写了一句话"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "old change");
    const wt = worktreeOf(root);
    writeDoc(wt, `canon/changes/${id("C", 9)}.md`, CHANGE(9, "- 只写了一句话"));
    const r = canon(wt, "check");
    expect(r.err).not.toContain(`canon/changes/${id("C", 8)}.md`);
  });

  test("BR-2549: the primary checkout prints no item notes at all", () => {
    const root = project();
    writeDoc(root, `canon/changes/${id("C", 9)}.md`, CHANGE(9, "- 只写了一句话"));
    const r = canon(root, "check");
    expect(r.err).not.toContain("教训 item");
    expect(r.code).toBe(0);
  });

  test("BR-2549: a declaration that says finding reports every document as item-mismatch and fails the check", () => {
    const root = project();
    writeFileSync(
      join(root, "canon/config.yaml"),
      'floor: test ! -e FAIL\ntests: []\nreview: none\ntypes:\n  adr:\n    prefix: ADR\n    dir: adrs\n    items:\n      选项:\n        format: "(?:[{verdict}] ){text}"\n        slots:\n          verdict: {enum: [采用, 否决], required: true}\n          text: text\n        on_mismatch: finding\n',
    );
    mkdirSync(join(root, "canon/adrs"), { recursive: true });
    writeDoc(root, `canon/adrs/${id("ADR", 3)}.md`, `---\nid: ${id("ADR", 3)}\ntitle: Old\n---\n\n## 选项\n\n- 没写标记的选项\n`);
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("item-mismatch");
    expect(r.out).toContain(`canon/adrs/${id("ADR", 3)}.md: 选项 item "没写标记的选项" lacks verdict (BR-2549)`);
  });
});

describe("canon show --json", () => {
  test("BR-2550: the object has the document and the items its declarations read, with a problem on the item that lacks dest", () => {
    const root = project();
    writeDoc(root, `canon/changes/${id("C", 9)}.md`, CHANGE(9, `- 子进程拿不到改过的环境 → ${id("BR", 2101)}\n- 只写了一句话`));
    const r = canon(root, "show", id("C", 9), "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { id: string; type: string; path: string; front: string; body: string; items: Record<string, unknown> };
    expect([out.id, out.type, out.path]).toEqual([id("C", 9), "change", `canon/changes/${id("C", 9)}.md`]);
    expect(out.front).toContain(`id: ${id("C", 9)}`);
    expect(out.body).toContain("## 教训");
    expect(out.items).toEqual({
      教训: [
        { raw: `子进程拿不到改过的环境 → ${id("BR", 2101)}`, slots: { text: "子进程拿不到改过的环境", dest: id("BR", 2101) }, children: [] },
        { raw: "只写了一句话", slots: { text: "只写了一句话" }, children: [], problem: "lacks dest" },
      ],
    });
  });

  test("BR-2547 BR-2550: a project pattern that backtracks badly does not hang canon show, and every item is read", () => {
    const root = project();
    writeFileSync(
      join(root, "canon/config.yaml"),
      'floor: test ! -e FAIL\ntests: []\nreview: none\ntypes:\n  adr:\n    prefix: ADR\n    dir: adrs\n    items:\n      选项:\n        format: "(?:[{tag}] ){text}"\n        slots:\n          tag: {pattern: "(a+)+"}\n          text: text\n',
    );
    const item = `[${"a".repeat(40)}!] x`;
    writeDoc(root, `canon/adrs/${id("ADR", 3)}.md`, `---\nid: ${id("ADR", 3)}\ntitle: Old\n---\n\n## 选项\n\n${Array.from({ length: 50 }, () => `- ${item}`).join("\n")}\n`);
    const started = performance.now();
    const r = Bun.spawnSync(["bun", MAIN, "show", id("ADR", 3), "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 20_000 });
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { items: Record<string, { slots: Record<string, string> }[]> };
    expect(out.items["选项"]).toHaveLength(50);
    expect(out.items["选项"]?.every((i) => i.slots["text"] === item && i.slots["tag"] === undefined)).toBe(true);
  });

  test("BR-2550: a document whose type declares no items has an empty items object", () => {
    const root = project();
    writeDoc(root, `canon/decisions/${id("D", 3)}.md`, `---\nid: ${id("D", 3)}\ntitle: Chosen\nstatus: accepted\n---\n\n## 背景\n\nWhy.\n\n## 方案\n\n1. Do it：采用\n\n## 决定\n\nDone.\n\n## 后果\n\nNone.\n`);
    const r = canon(root, "show", id("D", 3), "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { items: unknown }).items).toEqual({});
  });

  test("BR-2550: an id that does not exist fails with exit code 3, with or without --json", () => {
    const root = project();
    const missing = id("BR", 999);
    expect(canon(root, "show", missing, "--json").code).toBe(3);
    expect(canon(root, "show", missing).code).toBe(3);
  });
});
