import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

function lore(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, LORE_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "lore-next-cli-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", ...args], { cwd: root });
  return root;
}

describe("exit codes", () => {
  test("BR-2022: 0 ok, 1 refused by a check, 2 usage, 3 not found", () => {
    const root = repo();
    expect(lore(root, "init", "--floor", "true").code).toBe(0);
    expect(lore(root, "show", ["BR", 999].join("-")).code).toBe(3);
    expect(lore(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(0);
    expect(lore(root, "rule", "new", "--domain", "billing", "--title", "Refund window").code).toBe(0);
    const c = lore(root, "check");
    expect(c.code).toBe(1); // the new rule has no test and no reason
    expect(c.out).toContain("rule-untested");
    expect(lore(root, "rule", "new", "--domain", "nowhere", "--title", "X").code).toBe(3);
    expect(lore(root, "work", "start").code).toBe(2);
  });

  test("BR-2021: an agent session without a terminal cannot answer a human question", () => {
    const root = repo();
    lore(root, "init", "--floor", "true");
    expect(lore(root, "human", "ask", "Ship it?").code).toBe(0);
    const r = lore(root, "human", "answer", "1", "yes");
    expect(r.code).toBe(2);
    expect(r.err).toContain("TTY");
  });
});
