import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  test("BR-2022: usage errors from the command parser exit 2 and environment failures exit 4, never 1", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    expect(canon(root, "show").code).toBe(2); // missing positional
    expect(canon(root, "bogus").code).toBe(2); // unknown command
    expect(canon(root).code).toBe(2); // no command
    expect(canon(root, "--help").code).toBe(0);
    const outside = mkdtempSync(join(tmpdir(), "canon-not-a-repo-"));
    const r = canon(outside, "show", ["BR", 1].join("-"));
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a git repository");
  });

  test("BR-2001 BR-2012 BR-2037: a Chinese title gives a file and branch named by the id alone", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const d = canon(root, "decision", "new", "--title", "知识以文件存放");
    expect(d.code).toBe(0);
    expect(d.out.trim()).toMatch(/^canon\/decisions\/D-1\.md$/);
    expect(canon(root, "show", ["D", 1].join("-")).out).toContain("## 背景"); // BR-2037: Chinese template
    Bun.spawnSync(["git", "add", "-A"], { cwd: root });
    Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: root });
    const w = canon(root, "work", "start", "--title", "中文变更");
    expect(w.code).toBe(0);
    expect(w.out).toContain("(branch change/C-1)");
    expect(canon(root, "note", "new", "--title", "调研 API 方案").out.trim()).toBe("canon/notes/N-1.md");
    expect(canon(root, "decision", "new", "--title", "Use files").out.trim()).toBe(`canon/decisions/${["D", 2].join("-")}-use-files.md`);
  });

  test("BR-2037: a rule created without a body holds the template, which canon check reports until it is filled", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "rule", "domain", "billing", "--code", "src/billing", "--description", "Money.");
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n");
    canon(root, "rule", "new", "--domain", "billing", "--title", "Refunds", "--untested", "fixture");
    const id = ["BR", 1].join("-");
    const shown = canon(root, "show", id).out;
    expect(shown).toContain("## 规则");
    expect(shown).toContain("## 例子");
    expect(canon(root, "check").out).toContain(`template-unfilled  canon/rules/billing/${id}.md`);
  });

  test("BR-2044: a --timeout that is not a positive number is a usage error and never enters the queue", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const r = canon(root, "work", "land", "--timeout", "abc");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--timeout");
  });

  test("BR-2075: a question asked in a change worktree is seen from every worktree and hangs on that change", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const wt = canon(root, "work", "start", "--title", "Asking").out.match(/cd (.+)/)![1]!.trim();
    expect(canon(wt, "human", "ask", "Ship it?").code).toBe(0);
    expect(canon(root, "human", "pending").out).toContain("#1 [C-1] Ship it?");
    expect(canon(root, "human", "ask", "Rename it?").code).toBe(0); // the primary checkout holds no claim
    expect(canon(wt, "human", "pending").out).toContain("#2 [-] Rename it?");
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

function committed(root: string) {
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "c"], { cwd: root });
}

describe("project and documents", () => {
  test("BR-2032 BR-2076: init lays out canon/ with the floor, never overwrites, and warns without a floor", () => {
    const root = repo();
    const first = canon(root, "init");
    expect(first.code).toBe(0);
    expect(first.out).toContain("set `floor`");
    for (const p of ["canon/product.md", "canon/config.yaml", "canon/rules", "canon/decisions", "canon/changes", "canon/notes"]) {
      expect(Bun.spawnSync(["test", "-e", join(root, p)]).exitCode).toBe(0);
    }
    writeFileSync(join(root, "canon/product.md"), "mine");
    const again = canon(root, "init", "--floor", "true");
    expect(again.out).toContain("exists canon/product.md");
    expect(again.code).toBe(0);
    expect(readFileSync(join(root, "canon/product.md"), "utf8")).toBe("mine");
  });

  test("BR-2032: the product description init writes has the Chinese headings", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const text = readFileSync(join(root, "canon/product.md"), "utf8");
    for (const h of ["## 目的", "## 使用者", "## 承诺", "## 不做的事"]) expect(text).toContain(h);
  });

  test("BR-2027: accepting a decision supersedes the one it replaces; a non-decision target is not found", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "decision", "new", "--title", "Old way");
    canon(root, "decision", "new", "--title", "New way", "--supersedes", ["D", 1].join("-"));
    expect(canon(root, "decision", "accept", ["D", 2].join("-")).code).toBe(0);
    const list = canon(root, "decision", "list", "--all").out;
    expect(list).toMatch(/D-1\s+superseded/);
    expect(list).toMatch(/D-2\s+accepted/);
    canon(root, "decision", "new", "--title", "Bad", "--supersedes", ["C", 9].join("-"));
    expect(canon(root, "decision", "accept", ["D", 3].join("-")).code).toBe(3);
    expect(canon(root, "show", ["D", 3].join("-")).out).toContain("status: proposed"); // nothing was written
  });

  test("BR-2028 BR-2041: a retired rule keeps its file and leaves context; a dropped change keeps its file", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "rule", "domain", "billing", "--code", "src/billing");
    canon(root, "rule", "new", "--domain", "billing", "--title", "Refunds", "--untested", "fixture");
    const id = ["BR", 1].join("-");
    expect(canon(root, "rule", "retire", id).code).toBe(0);
    expect(canon(root, "show", id).out).toContain("status: retired");
    expect(canon(root, "context", "billing").out).not.toContain(id);
    canon(root, "change", "new", "--title", "Maybe");
    expect(canon(root, "change", "drop", ["C", 1].join("-")).code).toBe(0);
    expect(canon(root, "change", "list", "--all").out).toMatch(/C-1\s+dropped/);
  });
});

describe("starting existing changes", () => {
  test("BR-2038: a change that is not open cannot be started", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "change", "new", "--title", "Old");
    canon(root, "change", "drop", ["C", 1].join("-"));
    committed(root);
    const r = canon(root, "work", "start", ["C", 1].join("-"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("dropped");
  });
});

describe("session continuity", () => {
  test("BR-2024 BR-2025: stop records the next step; brief shows it to the next session; stop outside a change is not found", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    expect(canon(root, "work", "stop", "--next", "x").code).toBe(3);
    const started = canon(root, "work", "start", "--title", "Refunds");
    const wt = started.out.match(/cd (.+)/)![1]!.trim();
    expect(canon(wt, "brief").out).toContain("You are in C-1");
    expect(canon(wt, "work", "stop", "--next", "write the refund test", "--note", "half done").code).toBe(0);
    expect(canon(wt, "work", "stop", "--next", "land it").code).toBe(0); // replaces the earlier handoff
    const b = canon(wt, "brief").out;
    expect(b).toContain("next — land it");
    expect(b).not.toContain("write the refund test");
    expect(canon(root, "brief").out).toContain("Unfinished changes with handoffs: C-1");
    expect(canon(root, "work", "status").out).toContain("C-1"); // claim kept without --release
  });

  test("BR-2024: brief prints nothing when nothing is in flight", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    expect(canon(root, "brief").out).toBe("");
  });
});

describe("overlap in brief", () => {
  test("BR-2063: brief names the other change that touches the same file, and nothing when there is no overlap", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const wt = (title: string) => canon(root, "work", "start", "--title", title).out.match(/cd (.+)/)![1]!.trim();
    const a = wt("A");
    const b = wt("B");
    expect(canon(a, "brief").out).not.toContain("Overlap");
    for (const [dir, text] of [[a, "a"], [b, "b"]] as const) {
      writeFileSync(join(dir, "shared.txt"), text);
      Bun.spawnSync(["git", "add", "shared.txt"], { cwd: dir });
      Bun.spawnSync(["git", "commit", "-qm", "s"], { cwd: dir });
    }
    expect(canon(a, "brief").out).toContain("Overlap: C-2 also changes shared.txt");
    expect(canon(b, "brief").out).toContain("Overlap: C-1 also changes shared.txt");
  });
});

describe("dropping from the command line", () => {
  test("BR-2065 BR-2022: drop that would lose work exits 1 and names the question; nothing is deleted", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const wt = canon(root, "work", "start", "--title", "Risky").out.match(/cd (.+)/)![1]!.trim();
    writeFileSync(join(wt, "wip.txt"), "wip");
    const r = canon(root, "work", "drop", "C-1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("uncommitted: ?? wip.txt");
    expect(r.err).toContain("canon human answer 1 yes");
    expect(Bun.spawnSync(["test", "-d", wt]).exitCode).toBe(0);
  });
});
