import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { SCHEMA_FILE } from "./reference.ts";

// reason: these tests spawn the canon CLI, which is what they test.
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "../../cli/main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function withConfig(yaml: string) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), yaml);
  sh(root, "commit", "-q", "--allow-empty", "-am", "config");
  return root;
}

describe("canon config listing", () => {
  test("BR-2174: a key with no default that is not written shows (unset), floor included", () => {
    const r = canon(withConfig("tests: []\n"), "config");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toContain("floor = (unset)");
  });

  test("BR-2176: with --json, a schema file that cannot be written is said on stderr and stdout stays JSON", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    writeFileSync(join(root, ".canon"), "not a directory\n");
    sh(root, "add", ".canon");
    sh(root, "commit", "-qm", "a file named .canon");
    const r = canon(root, "config", "--json");
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
    expect(r.err.split("\n").filter((l) => l.includes(`cannot write ${SCHEMA_FILE}:`))).toHaveLength(1);
  });
});
