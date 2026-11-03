import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "../knowledge/check/check.ts";
import { testFilesFor } from "../knowledge/check/tests.ts";
import { readCorpus } from "../knowledge/documents/read.ts";
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
    ["a regenerable entry with a slash", "regenerable: [build/out]\n", "regenerable"],
    ["a batch size of 0", "land_batch_max: 0\n", "land_batch_max"],
    ["a batch size that is not whole", "land_batch_max: 2.5\n", "land_batch_max"],
  ];
  for (const [what, yaml, message] of cases) {
    test(`BR-2045: ${what} makes every command fail with exit 2`, () => {
      const root = repo({ "canon/config.yaml": yaml });
      const r = canon(root, "show", ["C", 1].join("-"));
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
    });
  }

  test("BR-2151: instructions default to CLAUDE.md, accept relative file paths and refuse anything else", () => {
    expect(readConfig(repo()).ok && (readConfig(repo()) as { value: { instructions: readonly string[] } }).value.instructions).toEqual(["CLAUDE.md"]);
    const good = readConfig(repo({ "canon/config.yaml": "instructions: [CLAUDE.md, src/cli/guide.ts]\n" }));
    expect(good.ok && good.value.instructions).toEqual(["CLAUDE.md", "src/cli/guide.ts"]);
    for (const yaml of ["instructions: CLAUDE.md\n", "instructions: [/etc/CLAUDE.md]\n", "instructions: [../CLAUDE.md]\n", "instructions: [docs/]\n"]) {
      const r = readConfig(repo({ "canon/config.yaml": yaml }));
      expect(!r.ok && r.error.message).toContain("`instructions` must be a list");
    }
  });

  test("BR-2160: test_command must be a string holding {file}, and a script it names must exist", () => {
    const good = readConfig(repo({ "canon/config.yaml": 'test_command: "npx vitest run {file}"\n' }));
    expect(good.ok && good.value.testCommand).toBe("npx vitest run {file}");
    const none = readConfig(repo());
    expect(none.ok && none.value.testCommand).toBeUndefined();
    for (const [yaml, message] of [
      ['test_command: "bun test"\n', "must contain {file}"],
      ["test_command: 3\n", "`test_command` must be a string"],
      ['test_command: "scripts/missing.sh {file}"\n', "scripts/missing.sh"],
    ] as const) {
      const r = canon(repo({ "canon/config.yaml": yaml }), "show", ["C", 1].join("-"));
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
    }
  });

  test("BR-2045: a number must be greater than 0, except land_keep_place_minutes, where 0 means keep no place (issue #64)", () => {
    const zero = readConfig(repo({ "canon/config.yaml": "land_keep_place_minutes: 0\n" }));
    expect(zero.ok && zero.value.landKeepPlaceMs).toBe(0);
    const negative = canon(repo({ "canon/config.yaml": "land_keep_place_minutes: -1\n" }), "show", ["C", 1].join("-"));
    expect([negative.code, negative.err.includes("land_keep_place_minutes")]).toEqual([2, true]);
    for (const key of ["claim_lease_hours", "lander_stale_minutes", "land_timeout_minutes"]) {
      const r = canon(repo({ "canon/config.yaml": `${key}: 0\n` }), "show", ["C", 1].join("-"));
      expect([key, r.code, r.err.includes(key)]).toEqual([key, 2, true]);
    }
  });

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

describe("code layout config", () => {
  const cases: [string, string, string][] = [
    ["shared without code_root", "shared: [src/kernel]\n", "`shared` needs `code_root`"],
    ["a shared entry outside code_root", "code_root: src\nshared: [lib/x]\n", "under src"],
    ["a shared entry that is the whole code_root", "code_root: src\nshared: [src]\n", "under src"],
    ["an absolute code_root", "code_root: /abs/src\n", "`code_root`"],
    ["a code_root with ..", "code_root: ../src\n", "`code_root`"],
    ["a code_root that is not a string", "code_root: [src]\n", "`code_root`"],
    ["shared that is not a list", "code_root: src\nshared: src/kernel\n", "`shared`"],
    ["shared with a null code_root", "code_root: null\nshared: [src/kernel]\n", "`shared` needs `code_root`"],
  ];
  for (const [what, yaml, message] of cases) {
    test(`BR-2116: ${what} makes every command fail with exit 2`, () => {
      const r = canon(repo({ "canon/config.yaml": yaml }), "show", ["C", 1].join("-"));
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
    });
  }

  test("BR-2116: shared: null is unset, so it needs no code_root (issue #62)", () => {
    const r = readConfig(repo({ "canon/config.yaml": "shared: null\n" }));
    expect(r.ok && [r.value.codeRoot, r.value.shared]).toEqual([undefined, []]);
  });

  test("BR-2116: code_root puts each domain's code at <code_root>/<domain path>; without it the top-level README decides", () => {
    const files = {
      "canon/rules/work/README.md": "---\ncode: [lib/work]\n---\n# work\n\n## 术语\n\n- **x**：y\n",
      "canon/rules/work/land/README.md": "# work/land\n\n## 术语\n\n- **x**：y\n",
    };
    const layered = repo({ ...files, "canon/config.yaml": "code_root: src\nshared: [src/kernel]\n" });
    const cfg = readConfig(layered);
    if (!cfg.ok) throw new Error(cfg.error.message);
    expect([cfg.value.codeRoot, cfg.value.shared]).toEqual(["src", ["src/kernel"]]);
    expect(readCorpus(layered, cfg.value.types, cfg.value).corpus.domains.map((d) => [d.name, d.code])).toEqual([["work", ["src/work"]], ["work/land", ["src/work/land"]]]);
    const plain = repo(files);
    expect(readCorpus(plain).corpus.domains.map((d) => [d.name, d.code])).toEqual([["work", ["lib/work"]], ["work/land", []]]);
  });
});

describe("test discovery", () => {
  const rule = (n: number) => `---\nid: ${br(n)}\ntitle: R\n---\n## 规则\n\nS.\n\n## 例子\n\n- a → b\n`;
  const base = {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n",
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

describe("floor_skip_paths", () => {
  test("BR-2165: relative paths are read; none may cover canon/config.yaml or canon/templates; absent is empty", () => {
    const read = (yaml?: string) => readConfig(repo(yaml === undefined ? {} : { "canon/config.yaml": yaml }));
    const good = read("floor_skip_paths: [canon/rules, canon/decisions]\n");
    expect(good.ok && good.value.floorSkipPaths).toEqual(["canon/rules", "canon/decisions"]);
    const none = read();
    expect(none.ok && none.value.floorSkipPaths).toEqual([]);
    const whole = read("floor_skip_paths: [canon]\n");
    expect(!whole.ok && whole.error.message).toContain("canon/config.yaml");
    for (const bad of ["[canon/templates/rule.md]", "[canon/config.yaml]", "[/abs/docs]", "[canon/rules/]", "canon/rules", "[../x]"]) {
      const r = read(`floor_skip_paths: ${bad}\n`);
      expect(r.ok ? `accepted ${bad}` : r.error.message).toContain("floor_skip_paths");
    }
  });
});

describe("script paths in commands", () => {
  /** `canon show C-1` in a repository with this config and these files, with HOME at `home`. */
  function run(yaml: string, files: Record<string, string> = {}, home = mkdtempSync(join(tmpdir(), "canon-home-"))) {
    const root = repo({ "canon/config.yaml": yaml, ...files });
    const r = Bun.spawnSync(["bun", MAIN, "show", ["C", 1].join("-")], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, HOME: home, CANON_ACTOR: "agent:test" } });
    return { code: r.exitCode, err: r.stderr.toString() };
  }
  const homeWith = (file: string) => {
    const home = mkdtempSync(join(tmpdir(), "canon-home-"));
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), "#!/bin/sh\n");
    return home;
  };

  test("BR-2197: a relative or absolute script path must exist; arguments after it are not part of it", () => {
    expect(run("review: scripts/missing.sh\n").err).toContain("scripts/missing.sh");
    expect(run("review: scripts/review.sh --fast\n", { "scripts/review.sh": "#!/bin/sh\n" }).code).toBe(3);
    expect(run("review: /no/such/review.sh\n").code).toBe(2);
  });

  test("BR-2197: a path starting with ~/ is under the home directory, not the repository (issue #63)", () => {
    const found = run("review: ~/bin/review.sh\n", {}, homeWith("bin/review.sh"));
    expect([found.code, found.err.includes("review.sh")]).toEqual([3, false]);
    const missing = run("review: ~/bin/review.sh\n");
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("runs ~/bin/review.sh, which does not exist");
  });

  test("BR-2197: a quoted first word is the whole quoted text, spaces included", () => {
    expect(run(`review: "'scripts/my review.sh' --fast"\n`, { "scripts/my review.sh": "#!/bin/sh\n" }).code).toBe(3);
    const missing = run(`review: "'scripts/my review.sh' --fast"\n`);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("runs scripts/my review.sh, which does not exist");
    // A quoted ~ is not expanded by the shell: '~/bin/review.sh' is a directory named ~ in the repository.
    const literal = run(`review: "'~/bin/review.sh'"\n`, {}, homeWith("bin/review.sh"));
    expect(literal.code).toBe(2);
    expect(run(`review: "'~/bin/review.sh'"\n`, { "~/bin/review.sh": "#!/bin/sh\n" }).code).toBe(3);
  });

  test("BR-2197: program names, words to expand and other users' homes are not checked", () => {
    for (const cmd of ["claude -p", '"$HOME/bin/review.sh"', "~other/bin/review.sh", "`which review`", "scripts/my\\ review.sh", 'scripts/"my review".sh']) {
      const r = run(`review: ${JSON.stringify(cmd)}\n`);
      expect([cmd, r.code]).toEqual([cmd, 3]);
    }
  });
});
