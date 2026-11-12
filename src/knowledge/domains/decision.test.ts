import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";

// reason: each case runs the CLI in a throwaway repository and a change worktree; under load one run takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function put(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const readme = (name: string) => `---\ncode: [${name}.txt]\n---\n# ${name}\n\n## 术语\n\n- **x**：y\n`;
const decision = (n: number, status: string, body: string) =>
  `---\nid: ${id("D", n)}\ntitle: D${n}\nstatus: ${status}\n---\n## 背景\n\n${body}\n\n## 方案\n\n1. A：采用。\n   - 来源：canon/config.yaml “floor: test”\n2. B：否决。\n\n## 决定\n\nA。\n\n## 后果\n\n无。\n`;

/** A project whose billing domain was there before the change, with no decision naming it. */
function fixture() {
  const root = project();
  put(root, { "canon/rules/billing/README.md": readme("billing"), "billing.txt": "x\n" });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const added = (wt: string, name: string) => {
  put(wt, { [`canon/rules/${name}/README.md`]: readme(name.split("/").at(-1)!), [`${name.split("/").at(-1)!}.txt`]: "x\n" });
};

describe("a new domain is a decision", () => {
  test("BR-2446: a domain this work adds with no decision naming it is refused; a domain that was already there is not", () => {
    const root = fixture();
    const change = startNew(root, "加领域");
    added(change.worktree, "shipping");
    const r = canon(change.worktree, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("domain-no-decision");
    expect(r.out).toContain("domain shipping is new");
    expect(r.out).not.toContain("domain billing is new"); // billing was there before this work
  });

  test("BR-2446: a decision this work writes, or one already on main, that names the domain lets it through", () => {
    const root = fixture();
    const change = startNew(root, "加领域");
    added(change.worktree, "shipping");
    put(change.worktree, { [`canon/decisions/${id("D", 1)}.md`]: decision(1, "proposed", "新领域 `shipping` 只管发货。") });
    expect(canon(change.worktree, "check").out).not.toContain("domain-no-decision");

    const onMain = fixture();
    put(onMain, { [`canon/decisions/${id("D", 2)}.md`]: decision(2, "accepted", "`shipping` 只管发货。") });
    sh(onMain, "add", "-A");
    sh(onMain, "commit", "-qm", "decision first");
    const later = startNew(onMain, "加领域");
    added(later.worktree, "shipping");
    expect(canon(later.worktree, "check").out).not.toContain("domain-no-decision");
  });

  test("BR-2446: a superseded decision does not count, and naming only the enclosing domain does not name the subdomain", () => {
    const root = fixture();
    const change = startNew(root, "加领域");
    added(change.worktree, "shipping");
    put(change.worktree, { [`canon/decisions/${id("D", 1)}.md`]: decision(1, "superseded", "`shipping` 只管发货。") });
    expect(canon(change.worktree, "check").out).toContain("domain shipping is new");

    put(change.worktree, { "canon/rules/billing/refunds/README.md": "# refunds\n\n## 术语\n\n- **x**：y\n" });
    put(change.worktree, { [`canon/decisions/${id("D", 1)}.md`]: decision(1, "accepted", "`billing` 和 `shipping` 都在。") });
    const sub = canon(change.worktree, "check");
    expect(sub.out).toContain("domain billing/refunds is new");
    expect(sub.out).not.toContain("domain shipping is new"); // D-1 names shipping

    // the other direction: naming a subdomain does not name its enclosing domain
    const other = fixture();
    const top = startNew(other, "加顶层领域");
    added(top.worktree, "shop");
    put(top.worktree, { [`canon/decisions/${id("D", 1)}.md`]: decision(1, "accepted", "`shop/orders` 只管订单。") });
    expect(canon(top.worktree, "check").out).toContain("domain shop is new");
  });

  test("BR-2446: in the main checkout, outside any change, nothing is reported", () => {
    const root = fixture();
    added(root, "shipping");
    expect(canon(root, "check").out).not.toContain("domain-no-decision");
  });
});
