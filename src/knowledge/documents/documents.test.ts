import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoordDb } from "../../work/db.ts";
import { check } from "../check/check.ts";
import { slugify } from "./model.ts";
import { readCorpus } from "./read.ts";
import { createDoc } from "./write.ts";

// reason: the CLI tests spawn canon processes, each a bun start plus git calls; under load one took 4.2 s of the 5 s default (C-111).
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
// Ids are assembled at runtime so this file does not itself name documents when canon check scans the repo.
const id = (p: string, n: number) => [p, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A git repository with `canon init` run in it. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-documents-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", ...args], { cwd: root });
  expect(canon(root, "init", "--floor", "true").code).toBe(0);
  return root;
}

/** Plain files, for reading the corpus in process. */
function files(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-documents-files-"));
  for (const [p, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const README = "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n";

describe("document files", () => {
  test("BR-2001: front matter that is missing, unterminated or not a mapping, a status outside the type's values and a malformed file name are each file-invalid; the rest still reads", () => {
    const root = files({
      "canon/rules/billing/README.md": README,
      [`canon/decisions/${id("D", 1)}.md`]: "## 背景\n\nNo front matter.\n",
      [`canon/decisions/${id("D", 2)}.md`]: `---\nid: ${id("D", 2)}\ntitle: Open\n`,
      [`canon/decisions/${id("D", 3)}.md`]: "---\n- a\n- b\n---\nList.\n",
      [`canon/decisions/${id("D", 4)}.md`]: `---\nid: ${id("D", 4)}\ntitle: Done\nstatus: done\n---\nX.\n`,
      [`canon/decisions/${id("D", 5)}_x.md`]: `---\nid: ${id("D", 5)}\ntitle: Underscore\n---\nX.\n`,
      [`canon/decisions/${id("D", 6)}-Use.md`]: `---\nid: ${id("D", 6)}\ntitle: Upper\n---\nX.\n`,
      "canon/rules/billing/rule-1.md": `---\nid: ${id("BR", 1)}\ntitle: Named wrong\n---\nX.\n`,
      [`canon/changes/${id("C", 1)}-ok.md`]: `---\nid: ${id("C", 1)}\ntitle: Ok\n---\nX.\n`,
    });
    const r = readCorpus(root);
    expect(r.problems.map((p) => p.path).sort()).toEqual(
      [
        `canon/decisions/${id("D", 1)}.md`,
        `canon/decisions/${id("D", 2)}.md`,
        `canon/decisions/${id("D", 3)}.md`,
        `canon/decisions/${id("D", 4)}.md`,
        `canon/decisions/${id("D", 5)}_x.md`,
        `canon/decisions/${id("D", 6)}-Use.md`,
        "canon/rules/billing/rule-1.md",
      ].sort(),
    );
    const byPath = Object.fromEntries(r.problems.map((p) => [p.path, p.message]));
    expect(byPath[`canon/decisions/${id("D", 1)}.md`]).toContain("missing front matter");
    expect(byPath[`canon/decisions/${id("D", 2)}.md`]).toContain("unterminated front matter");
    expect(byPath[`canon/decisions/${id("D", 3)}.md`]).toContain("must be a mapping");
    expect(byPath[`canon/decisions/${id("D", 4)}.md`]).toContain("status must be one of proposed, accepted, superseded");
    expect(r.corpus.docs.map((d) => `${d.id} ${"status" in d ? d.status : ""}`)).toEqual([`${id("C", 1)} open`]); // no status → the default
    const findings = check({ root, ...r, testFiles: [] }).filter((f) => f.rule === "file-invalid");
    expect(findings).toHaveLength(7);
  });

  test("BR-2001: a slug keeps at most 60 characters", () => {
    expect(slugify("a".repeat(80))).toBe("a".repeat(60));
  });

  test("BR-2003: each duplicate's message names the other file", () => {
    const root = files({
      [`canon/notes/${id("N", 1)}-a.md`]: `---\nid: ${id("N", 1)}\ntitle: A\n---\n`,
      [`canon/notes/${id("N", 1)}-b.md`]: `---\nid: ${id("N", 1)}\ntitle: B\n---\n`,
    });
    const dups = check({ root, ...readCorpus(root), testFiles: [] }).filter((f) => f.rule === "id-duplicate");
    expect(dups.map((f) => `${f.path} | ${f.message}`).sort()).toEqual([
      `canon/notes/${id("N", 1)}-a.md | ${id("N", 1)} is also used by canon/notes/${id("N", 1)}-b.md`,
      `canon/notes/${id("N", 1)}-b.md | ${id("N", 1)} is also used by canon/notes/${id("N", 1)}-a.md`,
    ]);
  });
});

describe("creating documents", () => {
  test("BR-2187: an empty title exits 2 and writes nothing; a file that already exists is a conflict and is left as it was", () => {
    const root = project();
    expect(canon(root, "note", "new", "--title", "   ").code).toBe(2);
    expect(existsSync(join(root, "canon/notes")) ? readdirSync(join(root, "canon/notes")) : []).toEqual([]);
    expect(canon(root, "note", "new", "--title", "Refunds").out.trim()).toBe(`canon/notes/${id("N", 1)}-refunds.md`);
    const opened = CoordDb.open(join(root, "state.db"));
    if (!opened.ok) throw new Error(opened.error.message);
    const first = createDoc(root, readCorpus(root).corpus, opened.value, "agent:test", { kind: "decision", title: "x", id: id("D", 1) });
    expect(first.ok).toBe(true);
    const path = join(root, `canon/decisions/${id("D", 1)}-x.md`);
    writeFileSync(path, `${readFileSync(path, "utf8")}edited\n`);
    const again = createDoc(root, readCorpus(root).corpus, opened.value, "agent:test", { kind: "decision", title: "x", id: id("D", 1) });
    expect(again.ok ? "" : again.error.code).toBe("conflict"); // exit 5 (BR-2022)
    expect(readFileSync(path, "utf8")).toEndWith("edited\n");
    opened.value.close();
  });

  test("BR-2037: a new decision has all four sections, a new domain README has 术语, and an unfilled 陷阱和假设 is template-unfilled", () => {
    const root = project();
    const decision = canon(root, "decision", "new", "--title", "知识以文件存放").out.trim();
    const text = readFileSync(join(root, decision), "utf8");
    for (const s of ["## 背景", "## 方案", "## 决定", "## 后果"]) expect(text).toContain(s);
    expect(canon(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(0);
    expect(readFileSync(join(root, "canon/rules/billing/README.md"), "utf8")).toContain("## 术语");
    const change = canon(root, "change", "new", "--title", "X").out.trim();
    const full = join(root, change);
    // Every section filled except 陷阱和假设, which keeps its placeholder.
    writeFileSync(
      full,
      readFileSync(full, "utf8")
        .replace("<要解决什么问题。>", "Why.")
        .replace("<具体改动，以及会新增或修改哪些规则。>", "What.")
        .replace(/<每条教训一行[^\n]*>/, "无")
        .replace("- [ ] <任务>", "- [ ] Do it"),
    );
    const findings = canon(root, "check").out.split("\n").filter((l) => l.includes(change));
    expect(findings.map((l) => l.split(/\s+/)[0])).toEqual(["template-unfilled"]);
  });
});

describe("statuses and domains from the CLI", () => {
  test("BR-2027: a decision that supersedes itself is refused on accept and stays proposed; new does not check the target", () => {
    const root = project();
    expect(canon(root, "decision", "new", "--title", "Self", "--supersedes", id("D", 1)).code).toBe(0);
    const r = canon(root, "decision", "accept", id("D", 1));
    expect(r.code).toBe(2);
    expect(r.err).toContain("supersedes itself");
    expect(canon(root, "show", id("D", 1)).out).toContain("status: proposed");
    const other = canon(root, "decision", "new", "--title", "Other", "--supersedes", id("C", 9));
    expect(other.code).toBe(0);
    expect(readFileSync(join(root, other.out.trim()), "utf8")).toContain(`supersedes: ${id("C", 9)}`);
  });

  test("BR-2115: creating a domain that exists exits 5 and leaves its README alone", () => {
    const root = project();
    expect(canon(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(0);
    const before = readFileSync(join(root, "canon/rules/billing/README.md"), "utf8");
    expect(canon(root, "rule", "domain", "billing", "--code", "src/other").code).toBe(5);
    expect(readFileSync(join(root, "canon/rules/billing/README.md"), "utf8")).toBe(before);
  });

  test("BR-2148: change list prints (no changes) when nothing is listed", () => {
    const root = project();
    expect(canon(root, "change", "list").out.trim()).toBe("(no changes)");
    canon(root, "change", "new", "--title", "Gone");
    canon(root, "change", "drop", id("C", 1));
    expect(canon(root, "change", "list").out.trim()).toBe("(no changes)");
    expect(canon(root, "change", "list", "--all").out).toMatch(/C-1\s+dropped/);
  });

  test("BR-2114: retired rules are not counted toward a domain's rules or the split hint", () => {
    const root = project();
    canon(root, "rule", "domain", "billing", "--code", "src/billing");
    for (let n = 1; n <= 27; n++) {
      const rid = id("BR", n);
      const status = n <= 2 ? "retired" : "active";
      writeFileSync(join(root, `canon/rules/billing/${rid}.md`), `---\nid: ${rid}\ntitle: R${n}\nstatus: ${status}\nuntested: fixture\n---\n## 规则\n\nX.\n`);
    }
    const out = canon(root, "rule", "domains").out;
    expect(out).toMatch(/billing\s+25 rules/);
    expect(out).not.toContain("consider subdomains");
  });
});
