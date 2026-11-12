import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { project } from "../../work/testkit.ts";

// reason: each case runs the CLI in a throwaway repository; under load one run takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("canon rule domains", () => {

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

  test("BR-2114: a domain that lists businesses has them under its line with their rule counts; one that lists none has no extra line", () => {
    const root = project();
    canon(root, "rule", "domain", "billing", "--code", "src/billing");
    canon(root, "rule", "domain", "auth", "--code", "src/auth");
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **x**：y\n\n## 业务\n\n- **退款**：钱退回\n- **对账**：和银行对账\n");
    writeFileSync(join(root, "canon/rules/auth/README.md"), "---\ncode: [src/auth]\n---\n# auth\n\n## 术语\n\n- **x**：y\n");
    const put = (domain: string, n: number, business?: string) =>
      writeFileSync(join(root, `canon/rules/${domain}/${id("BR", n)}.md`), `---\nid: ${id("BR", n)}\ntitle: R${n}\nstatus: active\nuntested: fixture\n${business === undefined ? "" : `business: ${business}\n`}---\n## 规则\n\nX.\n`);
    put("billing", 1, "退款");
    put("billing", 2, "退款");
    put("billing", 3);
    put("auth", 4, "会话");
    const out = canon(root, "rule", "domains").out;
    expect(out).toMatch(/\n {2}- 退款\s+2 rules/);
    expect(out).toMatch(/\n {2}- 对账\s+0 rules/);
    expect(out).toMatch(/\n {2}- in no business\s+1 rules/);
    // every rule under a listed business leaves the line out entirely
    writeFileSync(join(root, `canon/rules/billing/${id("BR", 3)}.md`), `---\nid: ${id("BR", 3)}\ntitle: R3\nstatus: active\nuntested: fixture\nbusiness: 对账\n---\n## 规则\n\nX.\n`);
    expect(canon(root, "rule", "domains").out).not.toContain("in no business");
    // the businesses of a domain come right after its own line, before its subdomains
    canon(root, "rule", "domain", "billing/refunds");
    const lines = canon(root, "rule", "domains").out.split("\n").map((l) => l.trim());
    const refund = lines.findIndex((l) => l.startsWith("- 退款"));
    const sub = lines.findIndex((l) => l.startsWith("billing/refunds"));
    expect(refund).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(refund);
    // auth lists no business, so its line stands alone even though one of its rules names one
    expect(out.split("\n").filter((l) => l.trim().startsWith("- ")).length).toBe(3);
    });
});
