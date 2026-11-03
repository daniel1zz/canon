import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { stringify } from "yaml";
import { CONFIG_KEYS, readConfig } from "../config.ts";
import { git } from "../../kernel/git.ts";
import { land } from "../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { configSchema, MODELINE, SCHEMA_FILE, schemaText, writeSchemaFile } from "./reference.ts";

// reason: these tests spawn the canon CLI and land changes in real repositories, which is what they test.
setDefaultTimeout(60_000);

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

const excludeOf = (root: string) => {
  const common = git(root, "rev-parse", "--git-common-dir");
  if (!common.ok) throw new Error(common.error.message);
  const file = join(common.value.startsWith("/") ? common.value : join(root, common.value), "info", "exclude");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

describe("canon config", () => {
  test("BR-2174: a written key shows its value, an absent one its default in the file's units, or (unset)", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\nland_batch_max: 4\n");
    const r = canon(root, "config");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toContain(`canon/config.yaml in ${realpathSync(root)} (this checkout)`);
    expect(lines[0]).toContain("lands like any other change");
    expect(lines).toContain(`floor = "test ! -e FAIL"`);
    expect(lines).toContain("land_batch_max = 4");
    expect(lines).toContain("claim_lease_hours = 12 (default)");
    expect(lines).toContain("setup = (unset)");
    // Every key canon knows is listed, each followed by its doc.
    for (const [, k] of CONFIG_KEYS) {
      const at = lines.findIndex((l) => l.startsWith(`${k.key} = `));
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(`  ${k.doc}`);
    }
  });

  test("BR-2174: --json gives key, set, value, default and doc for every key", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    const r = canon(root, "config", "--json");
    expect(r.code).toBe(0);
    const views = JSON.parse(r.out) as { key: string; set: boolean; value: unknown; default: unknown; doc: string }[];
    expect(views).toHaveLength(CONFIG_KEYS.length);
    expect(views.find((v) => v.key === "claim_lease_hours")).toMatchObject({ set: false, value: null, default: 12 });
    expect(views.find((v) => v.key === "floor")).toMatchObject({ set: true, value: "test ! -e FAIL", default: null });
  });

  test("BR-2174: an invalid config fails with exit 2 like every command", () => {
    const root = withConfig("floor: test ! -e FAIL\nbogus: 1\n");
    const r = canon(root, "config");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown key");
  });

  test("BR-2174: the modeline hint appears only while canon/config.yaml does not start with it", () => {
    const without = canon(withConfig("floor: test ! -e FAIL\ntests: []\n"), "config");
    expect(without.out.trimEnd().split("\n").at(-1)).toBe(`editor completion: make this the first line of canon/config.yaml: ${MODELINE}`);
    const withLine = canon(withConfig(`${MODELINE}\nfloor: test ! -e FAIL\ntests: []\n`), "config");
    expect(withLine.code).toBe(0);
    expect(withLine.out).not.toContain("editor completion");
  });
});

describe("the config schema", () => {
  const ajv = new Ajv({ allowUnionTypes: true });
  const validate = ajv.compile(configSchema());

  /** What canon's own reading says about a config, in a directory with nothing else in it. */
  function canonAccepts(config: Record<string, unknown>): boolean {
    const dir = mkdtempSync(join(tmpdir(), "canon-schema-"));
    mkdirSync(join(dir, "canon"));
    writeFileSync(join(dir, "canon/config.yaml"), stringify(config));
    return readConfig(dir).ok;
  }

  // Values on both sides of each key's boundary. `wider` marks a check JSON Schema cannot express: canon refuses,
  // the schema accepts (never the other way round, or an editor would mark a valid config).
  const samples: { config: Record<string, unknown>; ok: boolean; wider?: true }[] = [
    { config: {}, ok: true },
    { config: { floor: "bun test", land_batch_max: 4 }, ok: true },
    { config: { bogus: 1 }, ok: false },
    { config: { after_land: "x" }, ok: false },
    { config: { main: null }, ok: true },
    { config: { main: "" }, ok: true },
    { config: { main: 1 }, ok: false },
    { config: { floor: null }, ok: true },
    { config: { floor: ["bun test"] }, ok: false },
    { config: { tests: ["src/**/*.test.ts"] }, ok: true },
    { config: { tests: [] }, ok: true },
    { config: { tests: "src" }, ok: false },
    { config: { tests: null }, ok: false },
    { config: { test_command: "bun test {file}" }, ok: true },
    { config: { test_command: "" }, ok: true },
    { config: { test_command: null }, ok: true },
    { config: { test_command: "bun test" }, ok: false },
    { config: { setup: "bun install" }, ok: true },
    { config: { review: "scripts/missing-review.sh" }, ok: false, wider: true },
    { config: { review: "true" }, ok: true },
    { config: { worktrees: "../wt" }, ok: true },
    { config: { claim_lease_hours: 0.5 }, ok: true },
    { config: { claim_lease_hours: 0 }, ok: false },
    { config: { claim_lease_hours: -1 }, ok: false },
    { config: { claim_lease_hours: "12" }, ok: false },
    { config: { lander_stale_minutes: 5 }, ok: true },
    { config: { land_timeout_minutes: 0 }, ok: false },
    { config: { land_batch_max: 1 }, ok: true },
    { config: { land_batch_max: 0 }, ok: false },
    { config: { land_batch_max: 2.5 }, ok: false },
    { config: { floor_timing: "before" }, ok: true },
    { config: { floor_timing: "after" }, ok: true },
    { config: { floor_timing: "sometimes" }, ok: false },
    { config: { floor_timing: null }, ok: false },
    { config: { floor_timing: true }, ok: false },
    { config: { floor_skip_paths: ["canon/rules", "docs"] }, ok: true },
    { config: { floor_skip_paths: null }, ok: true },
    { config: { floor_skip_paths: ["canon/templates/x.md"] }, ok: false },
    { config: { floor_skip_paths: ["canon/config.yaml"] }, ok: false },
    { config: { floor_skip_paths: ["canon"] }, ok: false },
    { config: { floor_skip_paths: ["/abs"] }, ok: false },
    { config: { floor_skip_paths: ["a/../b"] }, ok: false },
    { config: { floor_skip_paths: ["docs/"] }, ok: false },
    { config: { instructions: ["CLAUDE.md", "docs/guide.md"] }, ok: true },
    { config: { instructions: ["./CLAUDE.md"] }, ok: false },
    { config: { regenerable: ["node_modules", "*.pyc"] }, ok: true },
    { config: { regenerable: ["a/b"] }, ok: false },
    { config: { regenerable: [" "] }, ok: false },
    { config: { code_root: "src" }, ok: true },
    { config: { code_root: null }, ok: true },
    { config: { code_root: "src/" }, ok: false },
    { config: { code_root: "src", shared: ["src/kernel"] }, ok: true },
    { config: { shared: ["src/kernel"] }, ok: false },
    { config: { code_root: "src", shared: ["lib/x"] }, ok: false, wider: true },
    { config: { code_root: "src", shared: null }, ok: true },
    { config: { shared: null }, ok: true },
    { config: { code_root: null, shared: null }, ok: true },
    { config: { code_root: null, shared: ["src/kernel"] }, ok: false },
    { config: { check_reviews: { floor: "2027-02-03" } }, ok: true },
    { config: { check_reviews: { floor: "2026-02-30" } }, ok: false, wider: true },
    { config: { check_reviews: { floor: "tomorrow" } }, ok: false },
    { config: { check_reviews: { nosuch: "2027-02-03" } }, ok: false },
    { config: { check_reviews: null }, ok: true },
    { config: { hooks: { after_land: "bun run build" } }, ok: true },
    { config: { hooks: { after_land: ["bun run build", "true"], before_land: "true" } }, ok: true },
    { config: { hooks: { after_land: "  " } }, ok: false },
    { config: { hooks: { after_land: null } }, ok: false },
    { config: { hooks: { after_green: ["bun run build"] } }, ok: true },
    { config: { hooks: { on_push: "true" } }, ok: false },
    { config: { hooks: null }, ok: true },
    { config: { types: { spec: { prefix: "SP", dir: "specs", statuses: ["draft", "done"], default: "draft", fields: ["owner"], sections: ["背景"] } } }, ok: true },
    { config: { types: { rule: { fields: ["owner"] } } }, ok: true },
    { config: { types: { Spec: { prefix: "SP", dir: "specs" } } }, ok: false },
    { config: { types: { spec: { prefix: "sp", dir: "specs" } } }, ok: false },
    { config: { types: { spec: { prefix: "SP", dir: "specs", color: "red" } } }, ok: false },
    { config: { types: { spec: { prefix: "SP", dir: "specs", fields: ["id"] } } }, ok: false },
    { config: { types: { spec: { prefix: "SP", dir: "specs", statuses: [] } } }, ok: false },
    { config: { types: { spec: { prefix: "SP", dir: "specs", sections: ["## x"] } } }, ok: false },
    { config: { types: { spec: { prefix: "BR", dir: "specs" } } }, ok: false, wider: true },
    { config: { types: { spec: { dir: "specs" } } }, ok: false, wider: true },
    { config: { types: { rule: { prefix: "R" } } }, ok: false, wider: true },
    { config: { types: { spec: { prefix: "SP", dir: "specs", statuses: ["a"], default: "b" } } }, ok: false, wider: true },
  ];

  test("BR-2175: the schema and canon's own reading agree; where they differ the schema is the wider one", () => {
    for (const s of samples) {
      const label = JSON.stringify(s.config);
      expect([label, canonAccepts(s.config)]).toEqual([label, s.ok]);
      expect([label, validate(s.config)]).toEqual([label, s.wider ? true : s.ok]);
    }
  });

  test("BR-2175: this repository's own canon/config.yaml passes the schema", () => {
    const own = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../../../canon/config.yaml"), "utf8"));
    expect(validate(own)).toBe(true);
  });

  test("BR-2175: every key has a property with its doc, and a schema default reads back to canon's default", () => {
    const props = (configSchema() as { properties: Record<string, { description: string; default?: unknown }> }).properties;
    expect(Object.keys(props).sort()).toEqual(CONFIG_KEYS.map(([, k]) => k.key).sort());
    for (const [, k] of CONFIG_KEYS) {
      expect(props[k.key]!.description).toBe(k.doc);
      if (!("default" in k.schema)) continue;
      const raw = Object.fromEntries((k.needs ?? []).map((n) => [n, "src"]));
      const r = k.read(k.schema["default"], { root: "/nowhere", raw });
      expect([k.key, r.ok ? r.value : r.error.message]).toEqual([k.key, k.default]);
    }
  });

  test("BR-2175: canon config --schema prints the schema", () => {
    const r = canon(withConfig("floor: test ! -e FAIL\ntests: []\n"), "config", "--schema");
    expect(r.code).toBe(0);
    expect(r.out).toBe(schemaText());
    expect(JSON.parse(r.out).additionalProperties).toBe(false);
  });
});

describe("the generated schema file", () => {
  test("BR-2176: canon brief writes .canon/config.schema.json, ignores it through info/exclude, and leaves the tree clean", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    expect(canon(root, "brief").code).toBe(0);
    expect(readFileSync(join(root, SCHEMA_FILE), "utf8")).toBe(schemaText());
    expect(excludeOf(root).split("\n").filter((l) => l === "/.canon/")).toHaveLength(1);
    expect(sh(root, "status", "--porcelain")).toBe("");
    expect(canon(root, "brief").code).toBe(0);
    expect(excludeOf(root).split("\n").filter((l) => l === "/.canon/")).toHaveLength(1);
  });

  test("BR-2176: the exclude line is appended after what info/exclude already holds, which stays as it was", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    const common = git(root, "rev-parse", "--git-common-dir");
    if (!common.ok) throw new Error(common.error.message);
    const file = join(common.value.startsWith("/") ? common.value : join(root, common.value), "info", "exclude");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, ".env");
    expect(canon(root, "brief").code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(".env\n/.canon/\n");
  });

  test("BR-2176: with /.canon/ already listed twice, brief appends nothing", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    const common = git(root, "rev-parse", "--git-common-dir");
    if (!common.ok) throw new Error(common.error.message);
    const file = join(common.value.startsWith("/") ? common.value : join(root, common.value), "info", "exclude");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "/.canon/\n/.canon/\n");
    expect(canon(root, "brief").code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("/.canon/\n/.canon/\n");
  });

  test("BR-2176: when .canon cannot be a directory, canon config still lists every key, says so in one line and exits 0", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    writeFileSync(join(root, ".canon"), "not a directory\n");
    sh(root, "add", ".canon");
    sh(root, "commit", "-qm", "a file named .canon");
    const r = canon(root, "config");
    expect(r.code).toBe(0);
    expect(r.out).toContain("claim_lease_hours = 12 (default)");
    expect(r.out.split("\n").filter((l) => l.startsWith(`cannot write ${SCHEMA_FILE}:`))).toHaveLength(1);
  });

  test("BR-2176: canon config writes it too", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    expect(canon(root, "config").code).toBe(0);
    expect(readFileSync(join(root, SCHEMA_FILE), "utf8")).toBe(schemaText());
  });

  test("BR-2176: when .canon cannot be a directory, brief says so in one line and still exits 0", () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    writeFileSync(join(root, ".canon"), "not a directory\n");
    sh(root, "add", ".canon");
    sh(root, "commit", "-qm", "a file named .canon");
    const r = canon(root, "brief");
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.startsWith(`cannot write ${SCHEMA_FILE}:`))).toHaveLength(1);
  });

  test("BR-2176: landing from a worktree that holds .canon is not refused as dirty", async () => {
    const root = withConfig("floor: test ! -e FAIL\ntests: []\n");
    const s = startNew(root, "Schema present");
    expect(canon(s.worktree, "brief").code).toBe(0);
    expect(existsSync(join(s.worktree, SCHEMA_FILE))).toBe(true);
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind).toBe("landed");
  });
});
