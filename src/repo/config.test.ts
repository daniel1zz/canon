import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../check/check.ts";
import { testFilesFor } from "../check/tests.ts";
import { readCorpus } from "../knowledge/read.ts";
import { readConfig } from "./config.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
const br = (n: number) => ["BR", n].join("-");

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "canon-config-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("config validation", () => {
  const cases: [string, string, string][] = [
    ["a misspelt key", "claim_lease_hour: 12\n", "unknown key `claim_lease_hour`"],
    ["the old top-level after_land", 'after_land: "bun run build"\n', "moved to `hooks.after_land`"],
    ["a script path that does not exist", "review: scripts/missing.sh\n", "scripts/missing.sh"],
    ["a non-positive number", "claim_lease_hours: 0\n", "claim_lease_hours"],
    ["a reshaped built-in type", "types:\n  rule:\n    prefix: R\n", "built-in type rule"],
    ["a reserved field", "types:\n  rule:\n    fields: [status]\n", "canon owns"],
    ["a duplicate prefix", "types:\n  spec:\n    prefix: D\n    dir: specs\n", "already the prefix"],
    ["a default outside the statuses", "types:\n  spec:\n    prefix: SP\n    dir: specs\n    statuses: [draft]\n    default: done\n", "default"],
    ["an unknown hook event", "hooks:\n  before_start: x\n", "unknown hook event"],
    ["invalid YAML", "floor: [\n", "not valid YAML"],
  ];
  for (const [what, yaml, message] of cases) {
    test(`BR-2045: ${what} makes every command fail with exit 2`, () => {
      const root = repo({ "canon/config.yaml": yaml });
      const r = canon(root, "show", ["C", 1].join("-"));
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
    });
  }

  test("BR-2045: a template for a type that is not declared is a config error", () => {
    const root = repo({ "canon/config.yaml": "main: main\n", "canon/templates/spec.md": "## x\n" });
    const r = canon(root, "check");
    expect(r.code).toBe(2);
    expect(r.err).toContain("canon/templates/spec.md");
  });

  test("BR-2045: a program on PATH is not checked, and no config file at all means the defaults", () => {
    const withPath = readConfig(repo({ "canon/config.yaml": "review: claude -p\n" }));
    expect(withPath.ok).toBe(true);
    const none = readConfig(repo());
    expect(none.ok && none.value.claimLeaseMs).toBe(12 * 3_600_000);
    expect(none.ok && none.value.landTimeoutMs).toBe(60 * 60_000);
    expect(canon(repo(), "rule", "domains").code).toBe(0);
  });
});

describe("test discovery", () => {
  const rule = (n: number) => `---\nid: ${br(n)}\ntitle: R\n---\n## 规则\n\nS.\n\n## 例子\n\n- a → b\n`;
  const base = {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n",
    [`canon/rules/billing/${br(1)}.md`]: rule(1),
  };
  const untested = (root: string) => {
    const cfg = readConfig(root);
    if (!cfg.ok) throw new Error(cfg.error.message);
    return check({ root, ...readCorpus(root), testFiles: testFilesFor(root, cfg.value) }).filter((f) => f.rule === "rule-untested").length;
  };

  test("BR-2046: configured globs are the only test files scanned", () => {
    expect(untested(repo({ ...base, "canon/config.yaml": 'tests: ["src/**/*.test.ts"]\n', "e2e/a.spec.ts": `it("${br(1)}", () => {});` }))).toBe(1);
  });

  test("BR-2046: without globs every *.test.* and *.spec.* counts, except under dist, canon, node_modules", () => {
    expect(untested(repo({ ...base, "e2e/a.spec.ts": `it("${br(1)}", () => {});` }))).toBe(0);
    expect(untested(repo({ ...base, "e2e/b.test.mts": `it("${br(1)}", () => {});` }))).toBe(0);
    expect(untested(repo({ ...base, "tools/a.test.py": `it("${br(1)}", () => {});` }))).toBe(1);
    expect(untested(repo({ ...base, "dist/a.test.js": `it("${br(1)}", () => {});` }))).toBe(1);
    expect(untested(repo({ ...base, "node_modules/x/a.test.js": `it("${br(1)}", () => {});` }))).toBe(1);
  });
});
