import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../../kernel/git.ts";

// reason: each case builds a repository, archives it and spawns the script, the AI stand-in and gh; slow under load
setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, "../../../scripts/consistency-review.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (n: number) => ["BR", n].join("-");
const R1 = id(1);
const R2 = id(2);
const R3 = id(3);

function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const readme = (name: string) => `# ${name}\n\n## 术语\n\n- **x**：y\n`;
const rule = (rid: string, text: string) => `---\nid: ${rid}\ntitle: Rule ${rid}\nstatus: active\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- a → b\n- c → d\n`;

/**
 * A repository with domains billing (BR-1), billing/sub (BR-3) and orders (BR-2), code_root src; the landing is
 * the commit that writes `landing`. Stand-ins: the AI saves each prompt to prompt-<n>.txt and prints answer.json
 * (or fails when ai-fails exists); gh logs each call and answers from closed.json, open.json and search.json.
 */
function setup(landing: Record<string, string>, opts: { answer?: unknown; closed?: unknown[]; open?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "canon-consistency-repo-"));
  const tools = mkdtempSync(join(tmpdir(), "canon-consistency-tools-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  write(root, {
    "canon/config.yaml": "code_root: src\n",
    "canon/rules/billing/README.md": readme("billing"),
    [`canon/rules/billing/${R1}.md`]: rule(R1, "退款超过原价时退出码 1。"),
    "canon/rules/billing/sub/README.md": readme("sub"),
    [`canon/rules/billing/sub/${R3}.md`]: rule(R3, "子领域的规则。"),
    "canon/rules/orders/README.md": readme("orders"),
    [`canon/rules/orders/${R2}.md`]: rule(R2, "订单规则。"),
    "src/billing/refund.ts": "export const refund = (x: number) => (x > 10 ? 0 : 1);\n",
    "src/billing/refund.test.ts": `import { it } from "bun:test";\nit("${R1}: covered case", () => {\n  // refund body line\n});\nit.skip("${R1}: skipped case", () => {});\n`,
    "src/billing/sub/s.ts": "export const s = 1;\n",
    "src/orders/o.ts": "export const o = 1;\n",
    "README.md": "readme\n",
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  const base = sh(root, "rev-parse", "HEAD");
  write(root, landing);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "landing");
  const head = sh(root, "rev-parse", "HEAD");
  writeFileSync(join(tools, "answer.json"), JSON.stringify(opts.answer ?? { findings: [] }));
  writeFileSync(join(tools, "closed.json"), JSON.stringify(opts.closed ?? []));
  writeFileSync(join(tools, "open.json"), JSON.stringify(opts.open ?? []));
  writeFileSync(join(tools, "search.json"), "[]");
  writeFileSync(
    join(tools, "ai.sh"),
    `n=$(ls ${tools} | grep -c '^prompt-')\ncat > ${tools}/prompt-$n.txt\nif [ -e ${tools}/ai-fails ]; then echo boom >&2; exit 1; fi\ncat ${tools}/answer.json\n`,
  );
  writeFileSync(
    join(tools, "gh.ts"),
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const dir = ${JSON.stringify(tools)};
appendFileSync(dir + "/gh.log", JSON.stringify(args) + "\\n");
const fail = (what: string) => existsSync(dir + "/fail-" + what);
if (args[1] === "list") {
  const which = args.includes("--search") ? "search" : args.includes("closed") ? "closed" : "open";
  if (fail(which)) process.exit(1);
  console.log(readFileSync(dir + "/" + which + ".json", "utf8"));
}
if (args[1] === "create") { if (fail("create")) process.exit(1); console.log("https://github.com/o/r/issues/77"); }
`,
  );
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, CANON_BASE: base, CANON_HEAD: head, CANON_CHANGE: "C-5", CANON_CONSISTENCY_AI: `sh ${join(tools, "ai.sh")}`, CANON_GH: `bun ${join(tools, "gh.ts")}`, ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const prompts = () => {
    const out: string[] = [];
    for (let n = 0; existsSync(join(tools, `prompt-${n}.txt`)); n++) out.push(readFileSync(join(tools, `prompt-${n}.txt`), "utf8"));
    return out;
  };
  const calls = () => (existsSync(join(tools, "gh.log")) ? readFileSync(join(tools, "gh.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  };
  return { root, tools, head, run, prompts, calls, cleanup };
}

const lines = (out: string) => out.trim().split("\n").filter(Boolean);
const finding = (over: Record<string, unknown> = {}) => ({
  kind: "code-mismatch",
  title: "Refund over the price returns 0",
  root_cause: "refund compares with 10 instead of the price",
  rule: R1,
  file: "src/billing/refund.ts",
  line: 1,
  scenario: "退款超过原价 → 返回 0，规则写退出码 1",
  existing: null,
  ...over,
});

describe("post-land consistency check: what it reads", () => {
  test("BR-2271: a change in a subdomain's code checks only that subdomain: its rules, the running tests naming them, its own code", () => {
    const s = setup({ "src/billing/sub/s.ts": "export const s = 2;\n", [`src/billing/sub/s.test.ts`]: `import { it } from "bun:test";\nit("${R3}: sub case", () => {});\n` });
    const r = s.run();
    expect(r.code).toBe(0);
    const [p, ...more] = s.prompts();
    expect(more).toEqual([]);
    expect(p).toContain(`canon/rules/billing/sub/${R3}.md`);
    expect(p).toContain("子领域的规则。");
    expect(p).not.toContain("退款超过原价时退出码 1。");
    expect(p).toContain("## src/billing/sub/s.ts\n\nexport const s = 2;");
    expect(p).not.toContain("## src/billing/refund.ts");
    expect(p).toContain(`it("${R3}: sub case"`);
    expect(p).not.toContain("## src/billing/sub/s.test.ts\n\nimport");
    expect(lines(r.out)).toEqual([`code-review: consistency: checking billing/sub: 1 rules, 1 tests, 1 code files, ${Buffer.byteLength(p!, "utf8")} bytes`, "code-review: consistency: billing/sub: no findings"]);
    s.cleanup();
  });

  test("BR-2271: a rule-only change checks its domain; running tests naming the rule are in the prompt, skipped ones are not", () => {
    const s = setup({ [`canon/rules/billing/${R1}.md`]: rule(R1, "退款超过原价时退出码 2。") });
    expect(s.run().code).toBe(0);
    const [p] = s.prompts();
    expect(p).toContain("退款超过原价时退出码 2。");
    expect(p).toContain(`## src/billing/refund.test.ts:2\n\nit("${R1}: covered case", () => {\n  // refund body line\n});`);
    expect(p).not.toContain("skipped case");
    expect(p).toContain("## src/billing/refund.ts");
    s.cleanup();
  });

  test("BR-2271: a landing that touches no domain calls no reviewer", () => {
    const s = setup({ "README.md": "changed\n" });
    const r = s.run();
    expect([r.code, lines(r.out), s.prompts().length]).toEqual([0, ["code-review: consistency: no domain's rules or code changed; nothing to check"], 0]);
    s.cleanup();
  });

  test("BR-2271: domains go by changed files, most first; --max-domains limits the calls and names the rest", () => {
    const landing = { "src/billing/refund.ts": "export const refund = 2;\n", "src/billing/new.ts": "export const n = 1;\n", "src/orders/o.ts": "export const o = 2;\n" };
    const one = setup(landing);
    const r = one.run();
    expect(r.code).toBe(0);
    expect(lines(r.out)[0]).toBe("code-review: consistency: not checked (--max-domains 1): orders");
    expect(one.prompts()).toHaveLength(1);
    expect(one.prompts()[0]).toContain("`billing`");
    one.cleanup();
    const two = setup(landing);
    expect(two.run(["--max-domains", "2"]).code).toBe(0);
    expect(two.prompts().map((p) => p.match(/domain of a project, `([^`]+)`/)![1])).toEqual(["billing", "orders"]);
    two.cleanup();
  });

  test("BR-2271: a prompt over --max-bytes is not sent and exits 0", () => {
    const s = setup({ "src/orders/o.ts": "export const o = 2;\n" });
    const r = s.run(["--max-bytes", "10"]);
    expect(r.code).toBe(0);
    expect(lines(r.out)).toHaveLength(1);
    expect(lines(r.out)[0]).toMatch(/^code-review: consistency: orders: \d+ bytes is over --max-bytes 10; not checked$/);
    expect(s.prompts()).toEqual([]);
    s.cleanup();
  });

  test("BR-2271: missing CANON_HEAD or a bad option exits 2; a failing reviewer exits 1", () => {
    const s = setup({ "src/orders/o.ts": "export const o = 2;\n" });
    expect(s.run([], { CANON_HEAD: "" }).code).toBe(2);
    expect(s.run(["--max-domains", "0"]).code).toBe(2);
    expect(s.run(["--max-bytes", "x"]).code).toBe(2);
    expect(s.run(["--what"]).code).toBe(2);
    writeFileSync(join(s.tools, "ai-fails"), "");
    const r = s.run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("code-review: consistency: ");
    expect(r.out).not.toContain("no findings");
    s.cleanup();
  });
});

describe("post-land consistency check: findings", () => {
  test("BR-2272: a finding naming a rule of the domain becomes a canon-consistency issue with the rule in each line", () => {
    const s = setup({ "src/billing/refund.ts": "export const refund = 2;\n" }, { answer: { findings: [finding()] } });
    const r = s.run();
    expect(r.code).toBe(0);
    const create = s.calls().find((c) => c[1] === "create")!;
    expect(create.slice(0, 6)).toEqual(["issue", "create", "--title", "Refund over the price returns 0", "--label", "canon-consistency"]);
    const body = create[create.indexOf("--body") + 1]!;
    expect(body.split("\n")[0]).toBe(`**code-mismatch**, found by the post-land consistency check of C-5 (\`${s.head.slice(0, 9)}\`).`);
    expect(body).toContain(`- \`src/billing/refund.ts:1\`: ${R1}: 退款超过原价 → 返回 0，规则写退出码 1`);
    expect(r.out).toContain("code-review: consistency: created https://github.com/o/r/issues/77");
    s.cleanup();
  });

  test("BR-2272: a rule of another domain, another kind or no line drops the finding; nothing is filed", () => {
    const answer = { findings: [finding({ rule: R2 }), finding({ kind: "security" }), finding({ line: undefined }), finding({ rule: undefined })] };
    const s = setup({ "src/billing/refund.ts": "export const refund = 2;\n" }, { answer });
    const r = s.run();
    expect(r.code).toBe(0);
    expect(s.calls().some((c) => c[1] === "create" || c[1] === "comment")).toBe(false);
    expect(lines(r.out).filter((l) => l.startsWith("code-review: consistency: dropped"))).toHaveLength(4);
    expect(lines(r.out).at(-1)).toBe("code-review: consistency: billing: no findings");
    s.cleanup();
  });

  test("BR-2272: an open canon-consistency issue the reviewer names gets a comment; one only under canon-review does not count", () => {
    const open = [{ number: 12, title: "Earlier", body: "x" }];
    const s = setup({ "src/billing/refund.ts": "export const refund = 2;\n" }, { answer: { findings: [finding({ existing: 12 })] }, open });
    expect(s.run().code).toBe(0);
    expect(s.calls().some((c) => c[1] === "comment" && c[2] === "12")).toBe(true);
    expect(s.calls().filter((c) => c[1] === "list" && c.includes("open")).every((c) => c[c.indexOf("--label") + 1] === "canon-consistency")).toBe(true);
    s.cleanup();
    const other = setup({ "src/billing/refund.ts": "export const refund = 2;\n" }, { answer: { findings: [finding({ existing: 13 })] }, open });
    expect(other.run().code).toBe(0);
    expect(other.calls().some((c) => c[1] === "create")).toBe(true);
    other.cleanup();
  });

  test("BR-2272: gh failing to create the issue exits 1 without no findings", () => {
    const s = setup({ "src/billing/refund.ts": "export const refund = 2;\n" }, { answer: { findings: [finding()] } });
    writeFileSync(join(s.tools, "fail-create"), "");
    const r = s.run();
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain("no findings");
    s.cleanup();
  });
});

describe("post-land consistency check: precision", () => {
  const closed = (completed: number, notPlanned: number) => [
    ...Array.from({ length: completed }, (_, i) => ({ number: i + 1, stateReason: "COMPLETED" })),
    ...Array.from({ length: notPlanned }, (_, i) => ({ number: 100 + i, stateReason: "NOT_PLANNED" })),
  ];

  test("BR-2273: 4 of 10 closed issues completed is below 0.5: no reviewer call, one off line, exit 0", () => {
    const s = setup({ "src/orders/o.ts": "export const o = 2;\n" }, { closed: closed(4, 6) });
    const r = s.run();
    expect([r.code, lines(r.out), s.prompts().length]).toEqual([0, ["code-review: consistency: off: precision 4/10 is below 0.5; remove it from hooks.after_land"], 0]);
    s.cleanup();
  });

  test("BR-2273: 5 of 10 is not below the line, and 9 closed are fewer than --min-closed: both still check", () => {
    for (const c of [closed(5, 5), closed(0, 9)]) {
      const s = setup({ "src/orders/o.ts": "export const o = 2;\n" }, { closed: c });
      expect(s.run().code).toBe(0);
      expect(s.prompts()).toHaveLength(1);
      s.cleanup();
    }
  });

  test("BR-2273: --precision prints completed/closed and the open count without CANON_BASE or a reviewer call", () => {
    const s = setup({ "src/orders/o.ts": "export const o = 2;\n" }, { closed: closed(2, 1), open: [1, 2, 3, 4].map((n) => ({ number: n, title: "t", body: "b" })) });
    const r = s.run(["--precision"], { CANON_BASE: "", CANON_HEAD: "" });
    expect([r.code, lines(r.out), s.prompts().length]).toEqual([0, ["code-review: consistency: precision 2/3, 4 open"], 0]);
    s.cleanup();
  });

  test("BR-2273: gh failing to list closed issues exits 1 before any reviewer call; a bad --min-precision exits 2", () => {
    const s = setup({ "src/orders/o.ts": "export const o = 2;\n" });
    writeFileSync(join(s.tools, "fail-closed"), "");
    const r = s.run();
    expect([r.code, s.prompts().length]).toEqual([1, 0]);
    expect(r.err).toContain("code-review: consistency: ");
    expect(s.run(["--min-precision", "2"]).code).toBe(2);
    expect(s.run(["--min-closed", "0"]).code).toBe(2);
    s.cleanup();
  });
});
