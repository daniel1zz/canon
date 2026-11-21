import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
// Ids are assembled at runtime so this file does not itself name rules when canon check scans the repo.
const id = (p: string, n: number) => [p, n].join("-");

const SPEC = "types:\n  spec:\n    prefix: SP\n    dir: specs\n    statuses: [draft, approved]\n";

function repo(config: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "canon-types-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  const all = { "canon/config.yaml": `floor: "true"\ntests: []\n${config}`, "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n", ...files };
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

  test("BR-2061: doc list shows every document of one declared type; an unknown type is not found, a built-in one is a usage error", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "status: draft\n", "One."), [`canon/specs/${id("SP", 2)}.md`]: doc("SP", 2, "status: approved\n", "Two.") });
    const out = canon(root, "doc", "list", "--type", "spec").out;
    expect(out).toMatch(new RegExp(`${id("SP", 1)}\\s+draft`));
    expect(out).toMatch(new RegExp(`${id("SP", 2)}\\s+approved`));
    const builtin = canon(root, "doc", "list", "--type", "rule");
    expect(builtin.code).toBe(2);
    expect(builtin.err).toContain("canon rule list");
    expect(canon(repo(""), "doc", "list", "--type", "spec").code).toBe(3);
    expect(canon(root, "doc", "list").code).toBe(2);
    writeFileSync(join(root, `canon/specs/${id("SP", 10)}.md`), doc("SP", 10, "status: draft\n", "Ten."));
    const ids = canon(root, "doc", "list", "--type", "spec").out.trim().split("\n").map((l) => l.split(/\s+/)[0]);
    expect(ids).toEqual([id("SP", 1), id("SP", 2), id("SP", 10)]);
  });

  test("BR-2051 BR-2077: a status outside the declared ones is invalid; doc status only accepts declared statuses", () => {
    const root = repo(SPEC, { [`canon/specs/${id("SP", 1)}.md`]: doc("SP", 1, "status: done\n", "One.") });
    expect(canon(root, "check").out).toContain(`file-invalid       canon/specs/${id("SP", 1)}.md: status must be one of draft, approved`);
    writeFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), doc("SP", 1, "status: draft\n", "One."));
    expect(canon(root, "doc", "status", id("SP", 1), "done").code).toBe(2);
    expect(readFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), "utf8")).toContain("status: draft");
    expect(canon(root, "doc", "status", id("SP", 1), "approved").code).toBe(0);
    expect(readFileSync(join(root, `canon/specs/${id("SP", 1)}.md`), "utf8")).toContain("status: approved");
    expect(canon(root, "check").out).not.toContain("file-invalid");
    expect(canon(root, "doc", "status", "C-1", "done").code).toBe(3);
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
    const rule = `---\nid: ${id("BR", 1)}\ntitle: Refunds\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nRefunds.\n`;
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

  test("BR-2054 BR-2622: the old list of field names reads as text fields; an empty one is reported, an older document without it is not", () => {
    const rule = (n: number, extra: string) => `---\nid: ${id("BR", n)}\ntitle: R${n}\nuntested: fixture\n${extra}business: x\n---\n## 规则\n\nS.\n`;
    const root = repo("types:\n  rule:\n    fields: [owner]\n", {
      [`canon/rules/billing/${id("BR", 1)}.md`]: rule(1, ""),
      [`canon/rules/billing/${id("BR", 2)}.md`]: rule(2, "owner: billing-team\n"),
      [`canon/rules/billing/${id("BR", 3)}.md`]: rule(3, 'owner: ""\n'),
      "canon/changes/C-1.md": doc("C", 1, "", `## 为什么\n\nTouches ${id("BR", 3)}.`),
    });
    const out = canon(root, "check").out;
    expect(out).toContain(`file-invalid       canon/rules/billing/${id("BR", 3)}.md: front matter \`owner\` is "", not a non-empty text`);
    expect(out).not.toContain(`${id("BR", 1)}.md`);
    expect(out).not.toContain(`${id("BR", 2)}.md`);
    expect(out).not.toContain("ref-dangling"); // the rule with a bad field still resolves
    const refused = canon(root, "rule", "new", "--domain", "billing", "--title", "New", "--untested", "fixture", "--business", "x");
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("missing owner: give --set owner=\"<value>\"");
    const made = canon(root, "rule", "new", "--domain", "billing", "--title", "New", "--untested", "fixture", "--business", "x", "--set", "owner=billing-team").out.trim().split("\n").at(-1)!;
    expect(readFileSync(join(root, made), "utf8")).toContain("owner: billing-team");
  });

  test("BR-2620: a creating command needs every field stated at creation, checked before an id is allocated; one refusal lists every problem", () => {
    const root = repo(DESIGN);
    const make = (...a: string[]) => canon(root, "doc", "new", "--type", "design", "--title", "D", ...a);
    for (const [args, says] of [
      [[], "missing reviewer: give --set reviewer=\"<value>\": a non-empty text"],
      [["--set", "reviewer="], "`reviewer` is \"\", not a non-empty text"],
      [["--set", "reviewer=ann", "--set", "risk=medium"], "`risk` is \"medium\", not one of low, high"],
      [["--set", "reviewer=ann", "--set", "colour=red"], "--set colour: design declares no field colour"],
      [["--set", "reviewer=ann", "--set", "reviewer=bob"], "reviewer is given twice"],
      [["--set", "reviewer=ann", "--set", "refs=none:"], "\"none:\" needs a reason after it"],
      [["--set", "reviewer"], "--set reviewer: write --set <field>=<value>"],
    ] as const) {
      const r = make(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("design not created, no id allocated (BR-2620)");
      expect(r.err).toContain(says);
    }
    const both = make("--set", "risk=medium");
    expect(both.err).toContain("missing reviewer");
    expect(both.err).toContain("not one of low, high");
    expect(existsSync(join(root, "canon/designs"))).toBe(false);
    const made = make("--set", "reviewer=ann", "--set", "refs=BR-1, D-2", "--set", "risk=low");
    expect(made.code).toBe(0);
    expect(made.out.trim()).toBe(`canon/designs/${id("DS", 1)}-d.md`);
    const text = readFileSync(join(root, made.out.trim()), "utf8");
    expect(text).toContain("reviewer: ann");
    expect(text).toMatch(/refs:\n {2}- BR-1\n {2}- D-2/);
    expect(make("--set", "reviewer=ann", "--set", "refs=none: new").out.trim()).toBe(`canon/designs/${id("DS", 2)}-d.md`);
  });

  test("BR-2623: the built-in types' fields stated at creation, with their own flags", () => {
    const root = repo("");
    const fail2 = (r: { code: number | null; err: string }, says: string) => {
      expect(r.code).toBe(2);
      expect(r.err).toContain(says);
    };
    fail2(canon(root, "rule", "new", "--domain", "billing", "--title", "R", "--untested", "f"), "missing business: give --business \"<business>\", one of the businesses billing's README lists: x");
    fail2(canon(root, "rule", "new", "--domain", "billing", "--title", "R", "--untested", "f", "--business", "nope"), "`business` is \"nope\", which billing's README does not list");
    const rule = canon(root, "rule", "new", "--domain", "billing", "--title", "R", "--untested", "f", "--business", "x");
    expect(rule.code).toBe(0);
    expect(readFileSync(join(root, rule.out.trim().split("\n").at(-1)!), "utf8")).toContain("business: x");

    fail2(canon(root, "change", "new", "--title", "C"), "missing owner_gate: give --owner-gate \"<what the owner approves>\" or --owner-gate \"none: <reason>\"");
    fail2(canon(root, "change", "new", "--title", "C", "--owner-gate", "none:", "--advances", "none: x"), "`owner_gate` must be a non-empty text");
    fail2(canon(root, "change", "new", "--title", "C", "--owner-gate", "none: tool", "--advances", "R-1"), "`advances` is a non-empty list of success criteria");
    const change = canon(root, "change", "new", "--title", "C", "--owner-gate", "研究站剧情设计稿", "--advances", "none: 修 bug");
    expect(change.code).toBe(0);
    const ctext = readFileSync(join(root, change.out.trim()), "utf8");
    expect(ctext).toContain("owner_gate: 研究站剧情设计稿");
    expect(ctext).toContain("advances: \"none: 修 bug\"");

    fail2(canon(root, "decision", "new", "--title", "D"), "missing amends: give --amends \"D-<n>, …\"");
    expect(canon(root, "decision", "new", "--title", "D", "--amends", "none: 新的选择").code).toBe(0);
    fail2(canon(root, "decision", "new", "--title", "D", "--amends", "D-1"), "missing revised_because: give --revised-because \"<reason>\", one of premise, requirement, external, experience, implementation, undetermined");
    fail2(canon(root, "decision", "new", "--title", "D", "--amends", "none: x", "--supersedes", "D-1"), "missing revised_because");
    fail2(canon(root, "decision", "new", "--title", "D", "--amends", "D-1", "--revised-because", "whim"), "`revised_because` is \"whim\", not one of premise");
    const dec = canon(root, "decision", "new", "--title", "D", "--amends", "D-1", "--revised-because", "experience");
    expect(dec.code).toBe(0);
    expect(readFileSync(join(root, dec.out.trim()), "utf8")).toMatch(/amends:\n {2}- D-1\nrevised_because: experience/);

    fail2(canon(root, "release", "new", "--title", "V"), "missing features: give --features \"F-<n>, …\"");
    expect(canon(root, "release", "new", "--title", "V", "--features", "none: 先列目标").code).toBe(0);
    expect(canon(root, "feature", "new", "--title", "F").code).toBe(0);
    expect(canon(root, "note", "new", "--title", "N").code).toBe(0);
    expect(canon(root, "check").out).not.toContain("file-invalid");
  });

  const DESIGN = "types:\n  design:\n    prefix: DS\n    dir: designs\n    fields:\n      reviewer: { type: text, due: create }\n      risk: { type: enum, values: [low, high] }\n      refs: { type: ids, none: true }\n";

  test("BR-2619: fields declare a shape and due; a wrong declaration is a config error naming type, field and why", () => {
    expect(canon(repo(DESIGN), "check").code).not.toBe(2);
    for (const [fields, says] of [
      ["      risk: { type: enum }\n", "an enum needs `values`"],
      ["      x: { type: colour }\n", "`types.design.fields.x.type` must be one of"],
      ["      x: { type: text, due: land }\n", "`types.design.fields.x.due` can only be create"],
      ["      x: { type: pattern, pattern: \"(?=a)\" }\n", "not a valid regular expression in RE2 syntax"],
      ["      x: { type: text, none: maybe }\n", "`types.design.fields.x.none` must be true or false"],
      ["      status: { type: text }\n", "`status` is a field canon owns"],
    ] as const) {
      const r = canon(repo(`types:\n  design:\n    prefix: DS\n    dir: designs\n    fields:\n${fields}`), "check");
      expect(r.code).toBe(2);
      expect(r.err + r.out).toContain(says);
    }
  });

  test("BR-2622: canon check reports a declared field whose value does not fit, and not one left out", () => {
    const root = repo(DESIGN, {
      [`canon/designs/${id("DS", 1)}.md`]: doc("DS", 1, 'reviewer: ""\n', "x"),
      [`canon/designs/${id("DS", 2)}.md`]: doc("DS", 2, 'reviewer: ann\nrefs: "none:"\n', "x"),
      [`canon/designs/${id("DS", 3)}.md`]: doc("DS", 3, "reviewer: ann\nrisk: medium\n", "x"),
      [`canon/designs/${id("DS", 4)}.md`]: doc("DS", 4, "", "x"),
      [`canon/designs/${id("DS", 5)}.md`]: doc("DS", 5, 'reviewer: ann\nrisk: low\nrefs: "none: new design"\n', "x"),
    });
    const out = canon(root, "check").out;
    expect(out).toContain(`${id("DS", 1)}.md: front matter \`reviewer\` is "", not a non-empty text`);
    expect(out).toContain(`${id("DS", 2)}.md: front matter \`refs\`: "none:" needs a reason after it`);
    expect(out).toContain(`${id("DS", 3)}.md: front matter \`risk\` is "medium", not one of low, high`);
    expect(out).not.toContain(`${id("DS", 4)}.md`);
    expect(out).not.toContain(`${id("DS", 5)}.md`);
  });

  test("BR-2621: canon doc set writes one declared field after checking it, records doc.set, and refuses everything else", () => {
    const root = repo(DESIGN, { [`canon/designs/${id("DS", 1)}.md`]: doc("DS", 1, "reviewer: ann\n", "x") });
    const file = join(root, `canon/designs/${id("DS", 1)}.md`);
    const set = (...a: string[]) => canon(root, "doc", "set", id("DS", 1), ...a);
    expect(set("risk", "high")).toMatchObject({ code: 0 });
    expect(readFileSync(file, "utf8")).toContain("risk: high");
    expect(set("risk", "high").out).toContain("no change");
    const before = readFileSync(file, "utf8");
    for (const [args, code, says] of [
      [["risk", "medium"], 2, "not one of low, high"],
      [["refs", "none:"], 2, "needs a reason"],
      [["status", "done"], 2, "written by canon"],
      [["owner", "x"], 2, "declares no field `owner`"],
      [["reviewer", "--clear"], 2, "cannot be removed"],
    ] as const) {
      const r = set(...args);
      expect(r.code).toBe(code);
      expect(r.err + r.out).toContain(says);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(set("refs", "BR-1, D-2").code).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/refs:\n {2}- BR-1\n {2}- D-2/);
    expect(set("refs", "none: new design").code).toBe(0);
    expect(set("risk", "--clear").code).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain("risk:");
    expect(canon(root, "doc", "set", id("DS", 9), "risk", "high").code).toBe(3);
    const events = Bun.spawnSync(["bun", MAIN, "events", "--kind", "doc.set", "--json"], { cwd: root, stdout: "pipe", env: { ...process.env, CANON_ACTOR: "agent:test" } }).stdout.toString();
    expect(JSON.parse(events).length).toBe(4);
  });

  test("BR-2055: a project template replaces the built-in one; a declared type without one starts empty", () => {
    const root = repo(SPEC, { "canon/templates/decision.md": "## 我们的背景\n\nx\n\n## 背景\n\n## 方案\n\n## 决定\n\n## 后果\n", "canon/templates/spec.md": "## 需求\n\ny\n" });
    expect(readFileSync(join(root, canon(root, "decision", "new", "--title", "A", "--amends", "none: t").out.trim()), "utf8")).toContain("## 我们的背景");
    expect(readFileSync(join(root, canon(root, "doc", "new", "--type", "spec", "--title", "B").out.trim()), "utf8")).toContain("## 需求");
    const plain = repo("types:\n  memo:\n    prefix: M\n    dir: memos\n");
    expect(readFileSync(join(plain, canon(plain, "decision", "new", "--title", "A", "--amends", "none: t").out.trim()), "utf8")).toContain("## 背景");
    const memo = readFileSync(join(plain, canon(plain, "doc", "new", "--type", "memo", "--title", "B").out.trim()), "utf8");
    expect(memo.split("---\n")[2]?.trim()).toBe("");
  });

  test("BR-2092: a type may declare its required sections; a rule may not, nor may a template lack one", () => {
    const decision = (n: number, body: string) => ({ [`canon/decisions/${id("D", n)}.md`]: doc("D", n, "", body) });
    const ok = repo("types:\n  decision:\n    sections: [背景, 决定]\n", { ...decision(1, "## 背景\n\nB.\n\n## 决定\n\nA.") });
    expect(canon(ok, "check").out).not.toContain("doc-missing-section");
    for (const bad of ["types:\n  rule:\n    sections: [规则]\n", 'types:\n  change:\n    sections: ["## 为什么"]\n', "types:\n  change:\n    sections: []\n".replace("[]", "[\"\"]")]) {
      const r = canon(repo(bad), "check");
      expect([r.code, r.err.includes("sections")]).toEqual([2, true]);
    }
    const tpl = repo("", { "canon/templates/change.md": "## 为什么\n\n<x>\n" });
    const r = canon(tpl, "check");
    expect([r.code, r.err.includes("`## 要改什么`")]).toEqual([2, true]);
    const extra = "types:\n  decision:\n    sections: [背景, 风险]\n";
    const builtin = canon(repo(extra), "check");
    expect([builtin.code, builtin.err.includes("built-in decision template")]).toEqual([2, true]);
    const own = canon(repo(extra, { "canon/templates/decision.md": "## 背景\n\n<b>\n\n## 风险\n\n<r>\n" }), "check");
    expect([own.code, own.err]).toEqual([1, ""]); // config loads; the check runs and reports only the fixture's missing code dir
    expect(own.out).toContain("domain-code-missing");
  });

  test("BR-2093: a declared type without a template starts from its required sections as placeholders", () => {
    const root = repo("types:\n  risk:\n    prefix: RK\n    dir: risks\n    sections: [影响, 应对]\n");
    const made = canon(root, "doc", "new", "--type", "risk", "--title", "A").out.trim();
    expect(readFileSync(join(root, made), "utf8").split("---\n")[2]?.trim()).toBe("## 影响\n\n<影响>\n\n## 应对\n\n<应对>");
    const out = canon(root, "check").out;
    expect(out).toContain("doc-missing-section");
    expect(out).toContain("template-unfilled");
  });
});

