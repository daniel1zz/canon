import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
function check(root: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, "check", ...args], { cwd: root, env: { ...process.env, CANON_ACTOR: "agent:test", CODEX_THREAD_ID: "codex-check", CODEX_SESSION_ID: "codex-check" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("BR-2256 BR-2257: Codex sizes use AGENTS and native skill descriptions, with override precedence", () => {
  const root = project();
  writeFileSync(join(root, "CLAUDE.md"), "legacy text\n");
  writeFileSync(join(root, "AGENTS.md"), "规则\n");
  mkdirSync(join(root, ".agents/skills/a"), { recursive: true });
  writeFileSync(join(root, ".agents/skills/a/SKILL.md"), "---\nname: a\ndescription: 做 A\n---\nBody\n");
  writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nsession_text_budget: 1\n");
  const r = check(root, "--sizes", "--json");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual([]);
  expect(r.err).toContain("session-text AGENTS.md: 7 bytes");
  expect(r.err).toContain("over session_text_budget 1 (AGENTS.md 7");
  expect(r.err).toContain("session-text .agents/skills/a/SKILL.md description: 5 bytes");
  expect(r.err).not.toContain("session-text CLAUDE.md");
  writeFileSync(join(root, "AGENTS.override.md"), "override\n");
  const override = check(root, "--sizes");
  expect(override.err).toContain("session-text AGENTS.override.md: 9 bytes");
  expect(override.err).not.toContain("session-text AGENTS.md:");
});

test("BR-2171: Codex root instructions report historical paths that were deleted", () => {
  const root = project();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/old.ts"), "old\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "old path");
  sh(root, "mv", "src/old.ts", "src/new.ts");
  sh(root, "commit", "-qm", "move path");
  writeFileSync(join(root, "AGENTS.md"), "Read `src/old.ts`.\n");
  const result = check(root, "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toContainEqual(expect.objectContaining({ rule: "path-missing", path: "AGENTS.md" }));
});
