import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
// Ids are assembled at runtime so this file does not itself name rules when canon check scans the repo.
const id = (p: string, n: number) => [p, n].join("-");

const SPEC = "types:\n  spec:\n    prefix: SP\n    dir: specs\n    statuses: [draft, approved]\n";

function repo(config: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "canon-types-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  const all = { "canon/config.yaml": `floor: "true"\n${config}`, "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n", ...files };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const doc = (prefix: string, n: number, extra: string, body: string) => `---\nid: ${id(prefix, n)}\ntitle: Doc ${n}\n${extra}---\n${body}\n`;

describe("declared document types", () => {
  test("BR-2050: canon doc new allocates the declared prefix, files it under its dir with the default status", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 7)}.md`]: doc("SP", 7, "status: draft\n", "Seven.") });
    const r = canon(root, "doc", "new", "--type", "spec", "--title", "Login flow");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`canon/specs/${id("SP", 8)}-login-flow.md`);
    expect(readFileSync(join(root, r.out.trim()), "utf8")).toContain("status: draft");
    expect(canon(root, "doc", "new", "--type", "spek", "--title", "X").code).toBe(3);
  });

  test("BR-2061: doc list shows every document of one declared type; a built-in or undeclared type is a usage error", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "status: draft\n", "One."), [`canon/specs/${id("SP", 2)}.md`]: doc("SP", 2, "status: approved\n", "Two.") });
    const out = canon(root, "doc", "list", "--type", "spec").out;
    expect(out).toMatch(new RegExp(`${id("SP", 1)}\\s+draft`));
    expect(out).toMatch(new RegExp(`${id("SP", 2)}\\s+approved`));
    const builtin = canon(root, "doc", "list", "--type", "rule");
    expect(builtin.code).toBe(2);
    expect(builtin.err).toContain("canon rule list");
    expect(canon(repo(""), "doc", "list", "--type", "spec").code).toBe(2);
  });

  test("BR-2051: a status outside the declared ones is invalid; doc status only accepts declared statuses", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "status: done\n", "One.") });
    expect(canon(root, "check").out).toContain(`file-invalid       canon/specs/${id("SP", 1)}.md: status must be one of draft, approved`);
    writeFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), doc("SP", 1, "status: draft\n", "One."));
    expect(canon(root, "doc", "status", id("SP", 1), "done").code).toBe(2);
    expect(readFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), "utf8")).toContain("status: draft");
    expect(canon(root, "doc", "status", id("SP", 1), "approved").code).toBe(0);
    expect(readFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), "utf8")).toContain("status: approved");
  });

  test("BR-2052: declared ids are checked like built-in ones: dangling and duplicate ids are reported; undeclared prefixes are not ids", () => {
    const files = {
      [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "", "One."),
      "canon/changes/C-1.md": doc("C", 1, "", `## 为什么\n\nImplements ${id("SP", 1)} and ${id("SP", 9)}; see ${id("XY", 3)}.`),
    };
    const root = repo(SPEC, files);
    const findings = canon(root, "check").out;
    expect(findings).toContain(`names ${id("SP", 9)}, which does not exist`);
    expect(findings).not.toContain(id("SP", 1) + ",");
    expect(findings).not.toContain(id("XY", 3));
    const undeclared = repo("", files);
    expect(canon(undeclared, "check").out).not.toContain(id("SP", 9));
    const dup = repo(SPEC, { [`canon/specs/${id("SP", 2)}-a.md`]: doc("SP", 2, "", "A."), [`canon/specs/${id("SP", 2)}-b.md`]: doc("SP", 2, "", "B.") });
    expect(canon(dup, "check").out.split("\n").filter((l) => l.startsWith("id-duplicate")).length).toBe(2);
  });

  test("BR-2060: declared ids are searchable and shown like built-in ones", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "", "One."), "canon/notes/N-1.md": doc("N", 1, "", `About ${id("SP", 1)}.`) });
    expect(canon(root, "search", id("SP", 1)).out.split("\n")[0]).toStartWith(id("SP", 1));
    const shown = canon(root, "show", id("SP", 1));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`canon/specs/${id("SP", 1)}.md`);
    expect(canon(root, "show", id("SP", 99)).code).toBe(3);
  });

  test("BR-2053: context lists declared-type documents that mention the domain's rules, and a declared id resolves to its domains", () => {
    const rule = `---\nid: ${id("BR", 1)}\ntitle: Refunds\nuntested: fixture\n---\n## 规则\n\nRefunds.\n`;
    const root = repo(SPEC, {
      [`canon/rules/billing/${id("BR", 1)}.md`]: rule,
      [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "", `Builds on ${id("BR", 1)}.`),
      [`canon/specs/${id("SP", 2)}.md`]: doc("SP", 2, "", "Unrelated."),
    });
    const ctx = canon(root, "context", "billing").out;
    expect(ctx).toContain("# spec");
    expect(ctx).toContain(`${id("SP", 1)} Doc 1 [draft]`);
    expect(ctx).not.toContain(id("SP", 2));
    expect(canon(root, "context", id("SP", 1)).out).toContain("# Domain: billing");
  });

  test("BR-2054: declared fields must be filled; new documents get them empty until then", () => {
    const rule = (n: number, extra: string) => `---\nid: ${id("BR", n)}\ntitle: R${n}\nuntested: fixture\n${extra}---\n## 规则\n\nS.\n`;
    const root = repo("types:\n  rule:\n    fields: [owner]\n", {
      [`canon/rules/billing/${id("BR", 1)}.md`]: rule(1, ""),
      [`canon/rules/billing/${id("BR", 2)}.md`]: rule(2, "owner: billing-team\n"),
      "canon/changes/C-1.md": doc("C", 1, "", `## 为什么\n\nTouches ${id("BR", 1)}.`),
    });
    const out = canon(root, "check").out;
    expect(out).toContain(`file-invalid       canon/rules/billing/${id("BR", 1)}.md: front matter \`owner\` is required`);
    expect(out).not.toContain(`${id("BR", 2)}.md`);
    expect(out).not.toContain("ref-dangling"); // the rule missing a field still resolves
    const made = canon(root, "rule", "new", "--domain", "billing", "--title", "New", "--untested", "fixture").out.trim();
    expect(readFileSync(join(root, made), "utf8")).toContain('owner: ""');
  });

  test("BR-2055: a project template replaces the built-in one; a declared type without one starts empty", () => {
    const root = repo(SPEC, { "canon/templates/decision.md": "## 我们的背景\n\nx\n", "canon/templates/spec.md": "## 需求\n\ny\n" });
    expect(readFileSync(join(root, canon(root, "decision", "new", "--title", "A").out.trim()), "utf8")).toContain("## 我们的背景");
    expect(readFileSync(join(root, canon(root, "doc", "new", "--type", "spec", "--title", "B").out.trim()), "utf8")).toContain("## 需求");
    const plain = repo("types:\n  memo:\n    prefix: M\n    dir: memos\n");
    expect(readFileSync(join(plain, canon(plain, "decision", "new", "--title", "A").out.trim()), "utf8")).toContain("## 背景");
    const memo = readFileSync(join(plain, canon(plain, "doc", "new", "--type", "memo", "--title", "B").out.trim()), "utf8");
    expect(memo.split("---\n")[2]?.trim()).toBe("");
  });
});
