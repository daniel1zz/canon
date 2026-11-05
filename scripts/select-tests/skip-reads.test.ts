import { describe, expect, test } from "bun:test";
import { readsOf } from "./skip-reads.ts";

// reason: fixture sources are assembled from pieces, so this file does not itself read like a test that reads the
// repository's own canon/rules or canon/notes
const META = ["import", "meta", "dir"].join(".");
const URLA = ["import", "meta", "url"].join(".");
const CWD = ["process", "cwd()"].join(".");
const RULES = ["canon", "rules"].join("/");
const NOTES = ["canon", "notes"].join("/");
const READ = ["read", "FileSync"].join("");

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
    `const MAIN = join(${META}, "..", "invocation", "main.ts");`,
    `const root = mkdtempSync(join(tmpdir(), "x-"));`,
    `writeFileSync(join(root, "${RULES}/x/BR-1.md"), "");`,
    `const out = join(${META}, "..", "..", "..", "..", "${RULES}");`,
    `spawnSync(["ls"], { cwd: MAIN });`,
    "",
  ].join("\n"),
};

const reads = (file: string) => readsOf(file, TESTS[file]!).map((r) => `${r.line} ${r.how} ${r.path || "<root>"}${r.partial ? " …" : ""}`);

describe("the repository paths a test reads", () => {
  test("BR-2350: each recognised way of reaching a file of the repository is found with its line; temp repos, paths outside the repository and other paths are not", () => {
    expect(reads("src/a/root.test.ts")).toEqual(["1 reads <root>", `2 reads ${RULES}/x/BR-1.md`]);
    expect(reads("src/a/partial.test.ts")).toEqual(["1 reads <root>", "2 reads canon …"]);
    expect(reads("src/a/forms.test.ts")).toEqual([
      "1 reads <root>",
      `2 reads ${NOTES}/N-1.md`,
      `3 reads ${RULES}/x.md`,
      `4 reads ${RULES}/x.md`,
      `5 reads ${RULES}`,
      "6 runs a command in <root> …",
    ]);
    // a temporary repository and a path outside the repository are no read of it; only the CLI's entry file is
    expect(reads("src/a/clean.test.ts")).toEqual(["1 reads src/invocation/main.ts", "5 runs a command in src/invocation/main.ts …"]);
  });
});
