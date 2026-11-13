import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../invocation/main.ts");
function sh(root: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canon-codex-install-"));
  sh(root, "init", "-qb", "main");
  const source = mkdtempSync(join(tmpdir(), "canon-codex-source-"));
  mkdirSync(join(source, "canon-a"));
  writeFileSync(join(source, "canon-a/SKILL.md"), "---\nname: canon-a\ndescription: A\n---\nSkill v1\n");
  return { root, source };
}
function cli(root: string, source: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: root, env: { ...process.env, CANON_ACTOR: "agent:fixture", CANON_SKILLS_SOURCE: source }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
function commit(root: string) {
  // The fixture has no external reviewer; the real lifecycle still runs the queue, floor and checks.
  writeFileSync(join(root, "canon/config.yaml"), 'main: main\nfloor: "true"\ntests: []\nreview: none\n');
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
}

describe("Codex project assets through the CLI", () => {
  test("BR-2459 BR-2032: Codex init writes native assets, a Codex reviewer and no Claude assets; repeat is current", () => {
    const { root, source } = fixture();
    const r = cli(root, source, "init", "--agent", "codex", "--floor", "true");
    expect(r.code).toBe(0);
    expect(read(root, ".agents/skills/canon-a/SKILL.md")).toContain("Skill v1");
    expect(read(root, ".codex/hooks.json")).toContain("--runtime codex");
    expect(read(root, ".codex/hooks.json")).not.toContain("baseRef");
    expect(read(root, "AGENTS.md")).toContain("canon brief");
    expect(read(root, "canon/config.yaml")).toContain('review: "codex exec --ephemeral --sandbox read-only -"');
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(r.out).toContain("trust");
    expect(r.out).toContain("git add -A");
    const before = read(root, ".codex/hooks.json");
    expect(cli(root, source, "install").code).toBe(0);
    expect(read(root, ".codex/hooks.json")).toBe(before);
    expect(cli(root, source, "update", "--check").code).toBe(0);
    expect(existsSync(join(root, ".git/canon/state.db"))).toBe(false);
  });

  test("BR-2459: default stays Claude and unrelated Codex directories do not select a target", () => {
    const { root, source } = fixture();
    mkdirSync(join(root, ".codex"));
    const own = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo own"}]}]}}';
    writeFileSync(join(root, ".codex/hooks.json"), own);
    expect(cli(root, source, "init", "--floor", "true").code).toBe(0);
    expect(existsSync(join(root, ".claude/skills/canon-a/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(read(root, ".codex/hooks.json")).toBe(own);
    expect(cli(root, source, "install", "--agent", "codex").code).toBe(0);
    expect(read(root, ".codex/hooks.json")).toContain("echo own");
    expect(read(root, ".agents/skills/canon-a/SKILL.md")).toContain("Skill v1");
    expect(cli(root, source, "update", "--check").code).toBe(0);
  });

  test("BR-2459 BR-2081: all targets preflight before writes; Codex JSON and local edits cannot half-update Claude", () => {
    const { root, source } = fixture();
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex/hooks.json"), "{broken");
    expect(cli(root, source, "init", "--agent", "all").code).toBe(2);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, "canon"))).toBe(false);
    writeFileSync(join(root, ".codex/hooks.json"), "{}");
    expect(cli(root, source, "init", "--agent", "all", "--floor", "true").code).toBe(0);
    writeFileSync(join(root, ".agents/skills/canon-a/SKILL.md"), "local edit\n");
    writeFileSync(join(source, "canon-a/SKILL.md"), "upstream v2\n");
    expect(cli(root, source, "install").code).toBe(5);
    expect(read(root, ".claude/skills/canon-a/SKILL.md")).toContain("Skill v1");
    expect(read(root, ".agents/skills/canon-a/SKILL.md")).toBe("local edit\n");
    expect(cli(root, source, "install", "--force").code).toBe(0);
    expect(read(root, ".claude/skills/canon-a/SKILL.md")).toBe("upstream v2\n");
    expect(read(root, ".agents/skills/canon-a/SKILL.md")).toBe("upstream v2\n");
  });

  test("BR-2460: AGENTS merge is idempotent; malformed markers and symlinks refuse before any assets", () => {
    const { root, source } = fixture();
    writeFileSync(join(root, "AGENTS.md"), "# Team\n\nKeep these rules.\n");
    expect(cli(root, source, "init", "--agent", "codex").code).toBe(0);
    const first = read(root, "AGENTS.md");
    expect(first).toStartWith("# Team\n\nKeep these rules.\n");
    expect(cli(root, source, "install").code).toBe(0);
    expect(read(root, "AGENTS.md")).toBe(first);
    for (const text of ["<!-- canon:begin -->", "<!-- canon:end -->\n<!-- canon:begin -->", "<!-- canon:begin --><!-- canon:begin --><!-- canon:end -->"]) {
      const f = fixture();
      writeFileSync(join(f.root, "AGENTS.md"), text);
      expect(cli(f.root, f.source, "init", "--agent", "codex").code).toBe(2);
      expect(existsSync(join(f.root, ".agents"))).toBe(false);
      expect(existsSync(join(f.root, ".codex"))).toBe(false);
    }
    const f = fixture();
    const outside = join(f.source, "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(f.root, "AGENTS.md"));
    expect(cli(f.root, f.source, "init", "--agent", "codex").code).toBe(2);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  test("BR-2459 BR-2460: update lands Codex assets; uninstall removes managed assets but keeps team instructions and tools", () => {
    const { root, source } = fixture();
    writeFileSync(join(root, "AGENTS.md"), "Team instructions.\n");
    expect(cli(root, source, "init", "--agent", "codex", "--floor", "true").code).toBe(0);
    mkdirSync(join(root, ".agents/skills/own"));
    writeFileSync(join(root, ".agents/skills/own/SKILL.md"), "own skill");
    const settings = JSON.parse(read(root, ".codex/hooks.json"));
    settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo own" }] });
    writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify(settings));
    commit(root);
    writeFileSync(join(source, "canon-a/SKILL.md"), "upstream v2\n");
    expect(cli(root, source, "update", "--check").code).toBe(1);
    const update = cli(root, source, "update");
    expect(update.code).toBe(0);
    expect(sh(root, "show", "main:.agents/skills/canon-a/SKILL.md")).toBe("upstream v2");
    expect(sh(root, "status", "--porcelain")).toBe("");
    const removed = cli(root, source, "uninstall");
    expect(removed.code).toBe(0);
    expect(existsSync(join(root, ".agents/skills/canon-a"))).toBe(false);
    expect(read(root, ".agents/skills/own/SKILL.md")).toBe("own skill");
    expect(read(root, "AGENTS.md").trim()).toBe("Team instructions.");
    expect(read(root, ".codex/hooks.json")).toContain("echo own");
    expect(read(root, ".codex/hooks.json")).not.toContain("canon brief");
  });

  test("BR-2459: an unknown target is refused without creating project assets", () => {
    const { root, source } = fixture();
    expect(cli(root, source, "init", "--agent", "typo").code).toBe(2);
    expect(existsSync(join(root, "canon"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  test("BR-2460: the active override receives the managed block and uninstall keeps both user files", () => {
    const { root, source } = fixture();
    writeFileSync(join(root, "AGENTS.md"), "Fallback instructions.\n");
    writeFileSync(join(root, "AGENTS.override.md"), "Active instructions.\n");
    expect(cli(root, source, "init", "--agent", "codex", "--floor", "true").code).toBe(0);
    expect(read(root, "AGENTS.md")).toBe("Fallback instructions.\n");
    expect(read(root, "AGENTS.override.md")).toStartWith("Active instructions.\n");
    expect(read(root, "AGENTS.override.md")).toContain("<!-- canon:begin -->");
    commit(root);
    const removed = cli(root, source, "uninstall");
    expect(removed.code).toBe(0);
    expect(read(root, "AGENTS.md")).toBe("Fallback instructions.\n");
    expect(read(root, "AGENTS.override.md")).toBe("Active instructions.\n");
  });

  test("BR-2459 BR-2083: a skill-root link to the source is not a source-repository exemption", () => {
    const { root, source } = fixture();
    mkdirSync(join(root, ".agents"));
    symlinkSync(source, join(root, ".agents/skills"));
    const r = cli(root, source, "init", "--agent", "codex");
    expect(r.code).toBe(2);
    expect(existsSync(join(root, ".codex"))).toBe(false);
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  test("BR-2459: an unrelated runtime argument does not opt user hooks into Canon updates", () => {
    const { root, source } = fixture();
    mkdirSync(join(root, ".codex"));
    const own = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-program --runtime codex" }] }] } });
    writeFileSync(join(root, ".codex/hooks.json"), own);
    expect(cli(root, source, "init", "--floor", "true").code).toBe(0);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(read(root, ".codex/hooks.json")).toBe(own);
  });
});
