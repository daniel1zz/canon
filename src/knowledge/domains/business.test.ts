import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";
import { businessesOf, contractLines } from "./business.ts";
import type { Corpus, Domain } from "../documents/model.ts";

// reason: these cases run the CLI in a throwaway repository and a change worktree; under load one run takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function put(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const readme = (name: string, businesses = "") => `# ${name}\n\n## 术语\n\n- **x**：y\n${businesses === "" ? "" : `\n## 业务\n\n${businesses}\n`}`;
const rule = (n: number, business?: string) =>
  `---\nid: BR-${n}\ntitle: Rule ${n}\nstatus: active\nuntested: 这个例子不验证行为\n${business === undefined ? "" : `business: ${business}\n`}---\n## 规则\n\nx。\n\n## 例子\n\n- x → y\n`;

const domain = (body: string): Domain => ({ name: "billing", path: "canon/rules/billing/README.md", code: [], declared: [], body });

/** A project whose billing domain lists one business, 退款, with BR-9 pointing at it and BR-10 pointing at nothing. */
function fixture() {
  const root = project();
  put(root, {
    "canon/rules/billing/README.md": readme("billing", "- **退款**：钱怎么退回去\n- **对账**：每天和银行对一次账"),
    "canon/rules/billing/BR-9.md": rule(9, "退款"),
    "canon/rules/billing/BR-10.md": rule(10),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

describe("the businesses a domain README lists", () => {
  test("BR-2430: a bold item under 业务 is a business; another shape, a repeat and a missing section are not", () => {
    const listed = businessesOf(domain("# billing\n\n## 业务\n\n- **退款**：钱怎么退回去\n- 对账：另一种写法\n- **退款**：又写了一次\n- **结算**：\n\n## 术语\n\n- **x**：y\n"));
    expect(listed.map((b) => b.name)).toEqual(["退款", "结算"]);
    expect(listed[0]!.text).toBe("钱怎么退回去");
    expect(listed[1]!.text).toBe("");
    expect(businessesOf(domain("# billing\n\n## 术语\n\n- **x**：y\n"))).toEqual([]);
    expect(businessesOf(domain("# billing\n\n## 业务\n\n- **<业务名>**：<这个业务管什么>\n"))).toEqual([]);
  });

  test("BR-2430: `business` with no value is refused when the file is read", () => {
    const root = fixture();
    put(root, { "canon/rules/billing/BR-11.md": `---\nid: BR-11\ntitle: Rule 11\nstatus: active\nbusiness:\n---\n## 规则\n\nx。\n` });
    const r = canon(root, "check");
    expect(r.out + r.err).toContain("`business` must name a business its domain README lists");
  });

  test("BR-2430: a domain created by canon rule domain has a 业务 section to fill", () => {
    const root = fixture();
    const change = startNew(root, "新建领域");
    expect(canon(change.worktree, "rule", "domain", "shipping", "--code", "src/shipping").code).toBe(0);
    expect(readFileSync(join(change.worktree, "canon/rules/shipping/README.md"), "utf8")).toContain("## 业务");
  });
});

describe("canon check on the business of a rule this work touched", () => {
  test("BR-2431: a rule this work adds or changes must name a business its domain lists", () => {
    const root = fixture();
    const change = startNew(root, "改规则");
    put(change.worktree, { "canon/rules/billing/BR-12.md": rule(12) });
    const added = canon(change.worktree, "check");
    expect(added.code).toBe(1);
    expect(added.out + added.err).toContain("rule-business-unmapped");
    expect(added.out + added.err).toContain("BR-12 has no `business`");
    expect(added.out + added.err).toContain("domain billing lists: 退款, 对账");

    put(change.worktree, { "canon/rules/billing/BR-12.md": rule(12, "退款") });
    expect((canon(change.worktree, "check").out + canon(change.worktree, "check").err)).not.toContain("rule-business-unmapped");
  });

  test("BR-2431: a business its domain does not list is refused, and so is a domain with no 业务 section", () => {
    const root = fixture();
    const change = startNew(root, "改规则");
    put(change.worktree, { "canon/rules/billing/BR-12.md": rule(12, "退货") });
    const unlisted = canon(change.worktree, "check");
    expect(unlisted.out + unlisted.err).toContain("BR-12 names business “退货”, which domain billing does not list");

    put(change.worktree, { "canon/rules/shipping/README.md": readme("shipping"), "canon/rules/shipping/BR-13.md": rule(13, "配送") });
    const noSection = canon(change.worktree, "check");
    expect(noSection.out + noSection.err).toContain("canon/rules/shipping/README.md has no ## 业务 section yet");
  });

  test("BR-2431: a rule this work did not touch is never reported, so nothing has to be migrated", () => {
    const root = fixture();
    const change = startNew(root, "不碰规则");
    put(change.worktree, { "app.txt": "changed\n" });
    const r = canon(change.worktree, "check");
    expect(r.out + r.err).not.toContain("rule-business-unmapped");
    expect(r.out + r.err).not.toContain("BR-10");
  });

  test("BR-2431: in the main checkout, outside any change, nothing is reported", () => {
    const root = fixture();
    put(root, { "canon/rules/billing/BR-12.md": rule(12) });
    const r = canon(root, "check");
    expect(r.out + r.err).not.toContain("rule-business-unmapped");
  });
});

describe("what canon rule new shows before it creates the file", () => {
  const corpus = (domains: readonly Domain[], docs: readonly unknown[]) => ({ domains, docs } as unknown as Corpus);
  const ruleDoc = (id: string, title: string, business?: string) => ({ kind: "rule", id, title, domain: "billing", status: "active", path: `canon/rules/billing/${id}.md`, body: "", ...(business === undefined ? {} : { business }) });

  test("BR-2432: each business is listed with its rules, an empty one is marked, and the rest are grouped as unassigned", () => {
    const lines = contractLines(
      corpus([domain("# billing\n\n## 业务\n\n- **退款**：钱怎么退回去\n- **对账**：每天和银行对一次账\n")], [ruleDoc("BR-9", "退款要在三天内到账", "退款"), ruleDoc("BR-8", "退款只退原路", "退款"), ruleDoc("BR-10", "没有业务的一条")]),
      "billing",
    );
    expect(lines.join("\n")).toContain("business: 退款 — 钱怎么退回去\n- BR-8 退款只退原路\n- BR-9 退款要在三天内到账");
    expect(lines.join("\n")).toContain("business: 对账 — 每天和银行对一次账\n- (no rule yet)");
    expect(lines.join("\n")).toContain("in no business (1)\n- BR-10 没有业务的一条");
  });

  test("BR-2432: a domain that lists no business says so instead", () => {
    const lines = contractLines(corpus([domain("# billing\n\n## 术语\n\n- **x**：y\n")], [ruleDoc("BR-9", "一条规则")]), "billing");
    expect(lines[0]).toContain("domain billing lists no business yet");
    expect(lines[1]).toBe("- BR-9 一条规则"); // the rules are still listed, just not grouped
  });

  test("BR-2432: canon rule new shows the domain's businesses first and the path last; canon decision new shows none", () => {
    const root = fixture();
    const change = startNew(root, "写新规则");
    const r = canon(change.worktree, "rule", "new", "--domain", "billing", "--title", "新的一条");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toStartWith("businesses of billing");
    expect(r.out).toContain("business: 退款 — 钱怎么退回去\n- BR-9 Rule 9");
    expect(r.out).toContain("in no business (1)\n- BR-10 Rule 10");
    expect(lines.at(-1)).toMatch(/^canon\/rules\/billing\/BR-\d+\.md$/);
    expect(canon(change.worktree, "decision", "new", "--title", "一个决策").out).not.toContain("businesses of");
    // BR-2432: the listing comes before the file is created, so a refusal at creation has already printed it; an unknown domain prints nothing
    const before = readdirSync(join(change.worktree, "canon/rules/billing")).length;
    const empty = canon(change.worktree, "rule", "new", "--domain", "billing", "--title", "");
    expect(empty.code).toBe(2);
    expect(empty.out).toContain("businesses of billing");
    expect(readdirSync(join(change.worktree, "canon/rules/billing")).length).toBe(before);
    const nowhere = canon(change.worktree, "rule", "new", "--domain", "nowhere", "--title", "x");
    expect(nowhere.code).toBe(3);
    expect(nowhere.out).not.toContain("businesses of");
    const neither = canon(change.worktree, "rule", "new", "--domain", "nowhere", "--title", "");
    expect(neither.code).toBe(2);
    expect(neither.out).not.toContain("businesses of");
    // BR-2432: without --domain it is a usage error: nothing listed, no file created
    const bare = canon(change.worktree, "rule", "new", "--title", "x");
    expect(bare.code).toBe(2);
    expect(bare.out).not.toContain("businesses of");
    expect(readdirSync(join(change.worktree, "canon/rules/billing")).length).toBe(before);
  });
});
