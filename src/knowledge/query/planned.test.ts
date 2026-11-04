import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { readCorpus } from "../documents/read.ts";
import { contextFor, renderContext } from "./query.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const br = (n: number) => ["BR", n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

const rule = (n: number, title: string, status: string) => `---\nid: ${br(n)}\ntitle: ${title}\nstatus: ${status}\nuntested: fixture\n---\n## 规则\n\n${title} body.\n`;

/** billing with active BR-1 退款, planned BR-2 部分退款, retired BR-3 旧手续费. */
function fixture(): string {
  const root = project();
  const files: Record<string, string> = {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    [`canon/rules/billing/${br(1)}.md`]: rule(1, "退款", "active"),
    [`canon/rules/billing/${br(2)}.md`]: rule(2, "部分退款", "planned"),
    [`canon/rules/billing/${br(3)}.md`]: rule(3, "旧手续费", "retired"),
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

describe("planned rules in context and show", () => {
  test("BR-2238 BR-2007: context lists a planned rule with [规划中], an active one without, a retired one not at all", () => {
    const root = fixture();
    const ctx = contextFor(readCorpus(root).corpus, "billing");
    expect(ctx.rules.map((r) => r.id)).toEqual([br(1), br(2)]);
    const brief = renderContext(root, ctx, { full: false, target: "billing" });
    expect(brief).toContain(`- ${br(1)} 退款\n`);
    expect(brief).toContain(`- ${br(2)} [规划中] 部分退款`);
    expect(brief).not.toContain(br(3));
    const full = renderContext(root, ctx, { full: true });
    expect(full).toContain(`## ${br(2)} [规划中] 部分退款\n\n## 规则\n\n部分退款 body.`);
    expect(full).toContain(`## ${br(1)} 退款\n`);
  });

  test("BR-2238 BR-2213: show marks a planned rule on the path line; an active rule's path line is the path alone", () => {
    const root = fixture();
    const planned = canon(root, "show", br(2));
    expect(planned.code).toBe(0);
    expect(planned.out.split("\n")[0]).toBe(`canon/rules/billing/${br(2)}.md  [规划中]`);
    expect(planned.out).toBe(`canon/rules/billing/${br(2)}.md  [规划中]\n\n${rule(2, "部分退款", "planned")}`);
    expect(canon(root, "show", br(1)).out.split("\n")[0]).toBe(`canon/rules/billing/${br(1)}.md`);
  });
});
