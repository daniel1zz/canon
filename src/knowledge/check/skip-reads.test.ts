import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { check } from "./check.ts";

// reason: the last test spawns the canon CLI, a bun start plus git calls (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
// reason: fixture sources are assembled from pieces, so this file does not itself read like a test that reads the
// repository's own canon/rules or canon/notes when canon check scans it (BR-2181)
const META = ["import", "meta", "dir"].join(".");
const URLA = ["import", "meta", "url"].join(".");
const CWD = ["process", "cwd()"].join(".");
const RULES = ["canon", "rules"].join("/");
const NOTES = ["canon", "notes"].join("/");
const READ = ["read", "FileSync"].join("");

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-skip-reads-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const ROOTED = `const ROOT = join(${META}, "..", "..");\n`;
const TESTS: Record<string, string> = {
  "src/a/root.test.ts": `${ROOTED}const t = ${READ}(join(ROOT, "${RULES}/x/BR-1.md"), "utf8");\n`,
  "src/a/partial.test.ts": `${ROOTED}for (const n of names) ${READ}(join(ROOT, "canon", n));\n`,
  "src/a/forms.test.ts": [
    ROOTED.trimEnd(),
    `const a = ${READ}(\`\${ROOT}/${NOTES}/N-1.md\`);`,
    `const b = new URL("../../${RULES}/x.md", ${URLA});`,
    `const c = ${READ}("${RULES}/x.md");`,
    `const d = join(${CWD}, "${RULES}");`,
    `spawnSync(["ls"], { cwd: ROOT });`,
    "",
  ].join("\n"),
  "src/a/clean.test.ts": [
    `const MAIN = join(${META}, "..", "cli", "main.ts");`,
    `const root = mkdtempSync(join(tmpdir(), "x-"));`,
    `writeFileSync(join(root, "${RULES}/x/BR-1.md"), "");`,
    `const out = join(${META}, "..", "..", "..", "..", "${RULES}");`,
    `spawnSync(["ls"], { cwd: MAIN });`,
    "",
  ].join("\n"),
  "tests/a.py": `open(Path(__file__).parent.parent / "${RULES}" / "x.md")\n`,
};

const found = (skip: readonly string[] | undefined, files = TESTS) => {
  const root = repo(files);
  return check({ root, ...readCorpus(root), testFiles: Object.keys(files), ...(skip ? { floorSkipPaths: skip } : {}) })
    .filter((f) => f.rule === "test-reads-skip-path");
};

describe("tests that read the repository's own files under floor_skip_paths", () => {
  test("BR-2181: each recognised way of reaching a skipped path from the repository is reported with its line; temp repos, other paths, paths outside the repository and other languages are not", () => {
    const f = found([RULES, NOTES]);
    expect(f.map((x) => x.path)).toEqual([
      "src/a/root.test.ts:2",
      "src/a/partial.test.ts:2",
      "src/a/forms.test.ts:2",
      "src/a/forms.test.ts:3",
      "src/a/forms.test.ts:4",
      "src/a/forms.test.ts:5",
      "src/a/forms.test.ts:6",
    ]);
    expect(f[0]!.message).toContain(`\`${RULES}/x/BR-1.md\` of the repository itself, under floor_skip_paths entry \`${RULES}\``);
    expect(f[1]!.message).toContain(`\`canon\` of the repository itself, which holds floor_skip_paths entry \`${RULES}\``);
    expect(f[2]!.message).toContain(`entry \`${NOTES}\``);
    expect(f[6]!.message).toMatch(/^runs a command in the repository root/);
  });

  test("BR-2181: without floor_skip_paths nothing is reported", () => {
    expect(found(undefined)).toEqual([]);
    expect(found([])).toEqual([]);
  });

  test("BR-2181: canon check reads floor_skip_paths from the config and exits 1 on such a test", () => {
    const files = {
      "canon/config.yaml": `floor: "true"\ntests: ["src/**/*.test.ts"]\nfloor_skip_paths: [${RULES}]\n`,
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# Billing\n\n## 术语\n\n- **退款**：钱退回\n",
      "src/billing/root.test.ts": `const ROOT = join(${META}, "..", "..");\nconst t = ${READ}(join(ROOT, "${RULES}/billing/README.md"));\n`,
    };
    const root = repo(files);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
    const r = Bun.spawnSync(["bun", MAIN, "check"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain(`test-reads-skip-path src/billing/root.test.ts:2: reads \`${RULES}/billing/README.md\``);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["src/**/*.test.ts"]\n`);
    const again = Bun.spawnSync(["bun", MAIN, "check"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
    expect(again.stdout.toString()).not.toContain("test-reads-skip-path");
  });
});
