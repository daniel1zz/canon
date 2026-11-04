import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";
import { envSpawnHints, renderEnvSpawnHint } from "./env-spawn.ts";

const MAIN = join(import.meta.dir, "../../cli/main.ts");
// reason: fixture sources are assembled from pieces, so this file does not itself assign process.env and spawn
// without env when canon check scans it (BR-2300)
const ENV = ["process", "env"].join(".");
const SPAWN = ["Bun", "spawn"].join(".");
const SPAWN_SYNC = ["Bun", "spawnSync"].join(".");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** Hints for one test file `src/a.test.ts` holding `lines`, as {assign, spawns}, or null when there is none. */
function hintFor(lines: string[], file = "src/a.test.ts"): { assign: number; spawns: number[] } | null {
  const root = mkdtempSync(join(tmpdir(), "canon-env-spawn-"));
  write(root, { [file]: `${lines.join("\n")}\n` });
  const h = envSpawnHints(root, [file]);
  return h.length ? { assign: h[0]!.assignLine, spawns: [...h[0]!.spawnLines] } : null;
}

const head = ['import { test } from "bun:test";', ""];
const assign = `${ENV}.X = "1";`;

describe("a test that assigns process.env and spawns a Bun child without env", () => {
  test("BR-2300: a spawn without options after an assignment is hinted with both lines", () => {
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["sh", "-c", "echo $X"]);`])).toEqual({ assign: 3, spawns: [5] });
  });

  test("BR-2300: a spawn that passes env, spreads its options, or takes them from a variable is not hinted", () => {
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["sh"], { env: { ...${ENV} } });`])).toBeNull();
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["sh"], { cwd: root, env });`])).toBeNull();
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["sh"], { cwd: root, ...opts });`])).toBeNull();
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["sh"], opts);`])).toBeNull();
  });

  test("BR-2300: options without env are hinted, nested env keys and the one-object form included", () => {
    expect(hintFor([...head, assign, `${SPAWN}({ cmd: ["sh"], stdout: "pipe" });`])).toEqual({ assign: 3, spawns: [4] });
    expect(hintFor([...head, assign, `${SPAWN}(["sh"], { cwd: join(root, "env"), stdio: [{ env: 1 }] });`])).toEqual({ assign: 3, spawns: [4] });
    expect(hintFor([...head, assign, `${SPAWN}(["sh"], { environment: "x" });`])).toEqual({ assign: 3, spawns: [4] });
  });

  test("BR-2300: every form of changing process.env counts; a spawn with no assignment in the file is not hinted", () => {
    const spawn = `${SPAWN}(["sh"], { cwd: root });`;
    for (const change of [`delete ${ENV}["X"];`, `${ENV}["X"] = "1";`, `${ENV}.PATH += ":/x";`, `${ENV}.X ??= "1";`, `Object.assign(${ENV}, vars);`]) {
      expect([change, hintFor([...head, change, spawn])]).toEqual([change, { assign: 3, spawns: [4] }]);
    }
    expect(hintFor([...head, `if (${ENV}.X === "1") {}`, spawn])).toBeNull();
    expect(hintFor([...head, spawn])).toBeNull();
  });

  test("BR-2300: one hint per file lists every spawn line; commented lines and non-JS/TS files do not count", () => {
    expect(hintFor([...head, assign, "", `${SPAWN_SYNC}(["a"]);`, "", "", "", `${SPAWN}(["b"], {});`])).toEqual({ assign: 3, spawns: [5, 9] });
    expect(hintFor([...head, `// ${assign}`, `${SPAWN_SYNC}(["sh"]);`])).toBeNull();
    expect(hintFor([...head, assign, `// ${SPAWN_SYNC}(["sh"]);`])).toBeNull();
    expect(hintFor([assign, `${SPAWN_SYNC}(["sh"])`], "src/a.test.py")).toBeNull();
  });

  test("BR-2300: the hint text names the file, the assignment and the spawn lines", () => {
    expect(renderEnvSpawnHint({ file: "src/a.test.ts", assignLine: 3, spawnLines: [5] })).toBe(
      "hint env-spawn: src/a.test.ts:3: assigns process.env and starts Bun children without env (line 5); they get the environment bun started with, not that change: pass env: { ...process.env } or set the variable before bun starts",
    );
    expect(renderEnvSpawnHint({ file: "src/a.test.ts", assignLine: 3, spawnLines: [5, 9] })).toContain("(lines 5, 9)");
  });
});

describe("the env-spawn hint on the command line", () => {
  const hints = (err: string) => err.split("\n").filter((l) => l.startsWith("hint env-spawn:"));
  const bad = [...head, assign, "", `${SPAWN_SYNC}(["sh", "-c", "echo $X"]);`].join("\n");

  test("BR-2300: canon check prints the hint on stderr only for files tests finds; stdout, --json and the exit code stay", () => {
    const root = project();
    write(root, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\nreview: none\n', "src/a.test.ts": `${bad}\n`, "tools/b.test.ts": `${bad}\n` });
    const r = canon(root, "check");
    expect([r.code, r.out.startsWith("ok: ")]).toEqual([0, true]);
    expect(hints(r.err)).toEqual([renderEnvSpawnHint({ file: "src/a.test.ts", assignLine: 3, spawnLines: [5] })]);
    const j = canon(root, "check", "--json");
    expect([j.code, JSON.parse(j.out), hints(j.err).length]).toEqual([0, [], 1]);
    write(root, { "src/a.test.ts": `${bad.replace('"echo $X"])', `"echo $X"], { env: { ...${ENV} } })`)}\n` });
    expect(hints(canon(root, "check").err)).toEqual([]);
  });

  test("BR-2300: canon work test prints the same hint and exits as it would without it", () => {
    const root = project();
    write(root, { "canon/config.yaml": 'floor: "true"\ntests: ["src/**/*.test.ts"]\ntest_command: "true {file}"\nreview: none\n', "src/a.test.ts": `${bad}\n` });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "fixture");
    const wt = startNew(root, "env spawn").worktree;
    const r = canon(wt, "work", "test");
    expect(r.code).toBe(0);
    expect(hints(r.err)).toEqual([renderEnvSpawnHint({ file: "src/a.test.ts", assignLine: 3, spawnLines: [5] })]);
  });
});
