import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-cli-"));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", ...args], { cwd: root });
  return root;
}

describe("exit codes", () => {
  test("BR-2022: 0 ok, 1 refused by a check, 2 usage, 3 not found", () => {
    const root = repo();
    expect(canon(root, "init", "--floor", "true").code).toBe(0);
    expect(canon(root, "show", ["BR", 999].join("-")).code).toBe(3);
    expect(canon(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(0);
    expect(canon(root, "rule", "new", "--domain", "billing", "--title", "Refund window").code).toBe(0);
    const c = canon(root, "check");
    expect(c.code).toBe(1); // the new rule has no test and no reason
    expect(c.out).toContain("rule-untested");
    expect(canon(root, "rule", "new", "--domain", "nowhere", "--title", "X").code).toBe(3);
    expect(canon(root, "work", "start").code).toBe(2);
  });

  test("BR-2001: a Chinese title gives a file and branch named by the id alone", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const d = canon(root, "decision", "new", "--title", "知识以文件存放");
    expect(d.code).toBe(0);
    expect(d.out.trim()).toMatch(/^canon\/decisions\/D-1\.md$/);
    expect(canon(root, "check").code).toBe(0);
    Bun.spawnSync(["git", "add", "-A"], { cwd: root });
    Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: root });
    const w = canon(root, "work", "start", "--title", "中文变更");
    expect(w.code).toBe(0);
    expect(w.out).toContain("(branch change/C-1)");
    expect(canon(root, "note", "new", "--title", "调研 API 方案").out.trim()).toBe("canon/notes/N-1.md");
  });

  test("BR-2021: an agent session without a terminal cannot answer a human question", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    expect(canon(root, "human", "ask", "Ship it?").code).toBe(0);
    const r = canon(root, "human", "answer", "1", "yes");
    expect(r.code).toBe(2);
    expect(r.err).toContain("TTY");
  });
});
