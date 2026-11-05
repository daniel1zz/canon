import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { land } from "../../work/land/land.ts";
import { FAST, project, sh, startNew, ws } from "../../work/testkit.ts";

// reason: the landing cases land in a throwaway repository; under load one landing takes seconds (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");
const OVERVIEW = "canon/architecture.md";

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function put(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

const readme = (name: string) => `# ${name}\n\n## 术语\n\n- **x**：y\n`;
const decision = (n: number, status: string, extra = "") =>
  `---\nid: ${id("D", n)}\ntitle: Decision ${n}\nstatus: ${status}\n${extra}---\n## 背景\n\nx.\n\n## 方案\n\n1. A：采用。\n   - 来源：canon/config.yaml “code_root: src”\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nnone.\n`;
const overview = (body: string) => `---\ntitle: 架构总览\n---\n# 架构总览\n\n${body}`;

/** A project with `code_root: src`, a billing domain, decisions D-5 (accepted) and D-7, and an overview naming `src/billing` and D-5. */
function fixture(body = "## 容器\n\n- 账单：`src/billing`。决策：D-5。\n") {
  const root = project();
  put(root, {
    "canon/config.yaml": "floor: test ! -e FAIL\ntests: []\nreview: none\ncode_root: src\ntest_command: \"true {file} {report}\"\n",
    "canon/rules/billing/README.md": readme("billing"),
    "src/billing/.keep": "",
    [`canon/decisions/${id("D", 5)}.md`]: decision(5, "accepted"),
    [`canon/decisions/${id("D", 7)}.md`]: decision(7, "accepted"),
    [OVERVIEW]: overview(body),
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

/** A new subdomain billing/refunds, with its code directory. */
const addRefunds = (root: string) => put(root, { "canon/rules/billing/refunds/README.md": readme("billing/refunds"), "src/billing/refunds/.keep": "" });
const kinds = (root: string) => {
  const r = canon(root, "check", "--json");
  return { code: r.code, kinds: (JSON.parse(r.out) as { rule: string }[]).map((f) => f.rule), err: r.err };
};

describe("architecture overview lists every domain's code directory", () => {
  test("BR-2352: a new domain whose directory the overview does not name is refused by canon check", () => {
    const root = fixture();
    addRefunds(root);
    const r = kinds(root);
    expect(r.code).toBe(1);
    expect(r.kinds).toEqual(["architecture-unlisted"]);
    expect(canon(root, "check").out).toContain("`src/billing/refunds`");
  });

  test("BR-2352: naming the directory whole counts, with a trailing slash too; a child path, a code block or a longer path do not", () => {
    for (const [body, listed] of [
      ["- `src/billing` and `src/billing/refunds`\n", true],
      ["- `src/billing` and `src/billing/refunds/`\n", true],
      ["- `src/billing` and `src/billing/refunds/x.ts`\n", false],
      ["- `src/billing`\n\n```\nsrc/billing/refunds\n```\n", false],
      ["- `src/billing` and `src/billing/refunds-old`\n", false],
    ] as const) {
      const root = fixture(`## 容器\n\n${body}`);
      addRefunds(root);
      expect(kinds(root).kinds).toEqual(listed ? [] : ["architecture-unlisted"]);
    }
  });

  test("BR-2352: a new shared path the overview does not name is refused", () => {
    const root = fixture();
    put(root, { "canon/config.yaml": "floor: test ! -e FAIL\ntests: []\nreview: none\ncode_root: src\nshared: [src/kernel]\n", "src/kernel/.keep": "" });
    expect(kinds(root).kinds).toEqual(["architecture-unlisted"]);
    expect(canon(root, "check").out).toContain("shared path src/kernel");
  });

  test("BR-2352: a domain that was already there is only a hint on standard error, exit 0", () => {
    const root = fixture();
    addRefunds(root);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "refunds, overview still silent");
    const r = kinds(root);
    expect(r.code).toBe(0);
    expect(r.kinds).toEqual([]);
    expect(r.err).toContain("hint architecture:");
    expect(r.err).toContain("`src/billing/refunds`");
  });

  test("BR-2352: nothing is reported when the overview has only headings, is missing, or code_root is not set", () => {
    const empty = fixture("");
    addRefunds(empty);
    expect(kinds(empty)).toMatchObject({ code: 0, kinds: [] });
    expect(kinds(empty).err).not.toContain("hint architecture");
    const missing = fixture();
    sh(missing, "rm", "-q", OVERVIEW);
    addRefunds(missing);
    expect(kinds(missing)).toMatchObject({ code: 0, kinds: [] });
    const noRoot = fixture();
    put(noRoot, { "canon/config.yaml": "floor: test ! -e FAIL\ntests: []\nreview: none\n# code_root: src\n", "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **x**：y\n" });
    expect(kinds(noRoot)).toMatchObject({ code: 0, kinds: [] });
  });

  test("BR-2352: a landing that adds a domain without naming its directory is refused for check", async () => {
    const root = fixture();
    const s = startNew(root, "Add refunds");
    addRefunds(s.worktree);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "refunds");
    const out = await land(ws(s.worktree), FAST, () => {});
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(JSON.stringify(out)).toContain("architecture-unlisted");
  });

  test("BR-2352: canon work test in a worktree that adds a domain without naming it reports architecture-unlisted", () => {
    const root = fixture();
    const s = startNew(root, "Add refunds");
    addRefunds(s.worktree);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "refunds");
    const r = canon(s.worktree, "work", "test");
    expect(r.out + r.err).toContain("architecture-unlisted");
    expect(r.code).not.toBe(0);
  });
});

describe("architecture overview names only current decisions", () => {
  test("BR-2353: a superseded decision named in the overview is reported, with the decision that replaced it", () => {
    const root = fixture();
    put(root, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "superseded"), [`canon/decisions/${id("D", 9)}.md`]: decision(9, "accepted", `supersedes: ${id("D", 5)}\n`) });
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("architecture-superseded");
    expect(r.out).toContain(`names ${id("D", 5)}, which is superseded by ${id("D", 9)}`);
  });

  test("BR-2353: a superseded decision named in the overview is reported when the replacing decision lists it in a supersedes list", () => {
    const root = fixture();
    put(root, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "superseded"), [`canon/decisions/${id("D", 9)}.md`]: decision(9, "accepted", `supersedes: [${id("D", 4)}, ${id("D", 5)}]\n`), [`canon/decisions/${id("D", 4)}.md`]: decision(4, "superseded") });
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`names ${id("D", 5)}, which is superseded by ${id("D", 9)}`);
  });

  test("BR-2353: an accepted or proposed decision, a backticked id, and an empty overview report nothing", () => {
    const accepted = fixture();
    expect(kinds(accepted).kinds).toEqual([]);
    const proposed = fixture();
    put(proposed, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "proposed") });
    expect(kinds(proposed).kinds).toEqual([]);
    const code = fixture("## 容器\n\n- `src/billing`；编号写成 `D-5`。\n");
    put(code, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "superseded"), [`canon/decisions/${id("D", 9)}.md`]: decision(9, "accepted", `supersedes: ${id("D", 5)}\n`) });
    expect(kinds(code).kinds).toEqual([]);
    const empty = fixture("");
    put(empty, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "superseded"), [`canon/decisions/${id("D", 9)}.md`]: decision(9, "accepted", `supersedes: ${id("D", 5)}\n`) });
    expect(kinds(empty).kinds).toEqual([]);
  });

  test("BR-2353: a landing whose tree accepts the replacement while the overview still names the old decision is refused", async () => {
    const root = fixture();
    const s = startNew(root, "Replace D-5");
    put(s.worktree, { [`canon/decisions/${id("D", 5)}.md`]: decision(5, "superseded"), [`canon/decisions/${id("D", 9)}.md`]: decision(9, "accepted", `supersedes: ${id("D", 5)}\n`) });
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "supersede");
    const out = await land(ws(s.worktree), FAST, () => {});
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(JSON.stringify(out)).toContain("architecture-superseded");
  });
});

describe("a new link to a decision the overview names needs the overview looked at", () => {
  const amend = (root: string, target = id("D", 5), status = "accepted") => put(root, { [`canon/decisions/${id("D", 9)}.md`]: decision(9, status, `amends:\n  - ${target}\n`) });
  const commit = (root: string) => {
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "work");
  };
  const unreviewed = (root: string) => canon(root, "check", "--json").out.includes("architecture-unreviewed");

  test("BR-2354: a decision that amends a named decision, without touching the overview, is reported at the new decision's file", () => {
    const root = fixture();
    amend(root);
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`architecture-unreviewed canon/decisions/${id("D", 9)}.md: ${id("D", 9)} amends ${id("D", 5)}`);
  });

  test("BR-2354: editing the overview in the same work satisfies it", () => {
    const root = fixture();
    amend(root);
    put(root, { [OVERVIEW]: overview("## 容器\n\n- 账单：`src/billing`。决策：D-5、D-9。\n") });
    expect(unreviewed(root)).toBe(false);
  });

  test("BR-2354: a change file saying the overview is not affected satisfies it, a placeholder reason does not", () => {
    const root = fixture();
    amend(root);
    const change = (line: string) => `---\nid: ${id("C", 1)}\ntitle: X\nstatus: open\n---\n\n## 为什么\n\nx.\n\n## 要改什么\n\n${line}\n\n## 任务\n\n- [ ] x\n`;
    put(root, { [`canon/changes/${id("C", 1)}.md`]: change("总览不受影响：<原因>") });
    expect(unreviewed(root)).toBe(true);
    put(root, { [`canon/changes/${id("C", 1)}.md`]: change("总览不受影响：只改了评审的措辞") });
    expect(unreviewed(root)).toBe(false);
  });

  test("BR-2354: a proposed superseding decision counts too", () => {
    const root = fixture();
    put(root, { [`canon/decisions/${id("D", 9)}.md`]: decision(9, "proposed", `supersedes: ${id("D", 5)}\n`) });
    expect(unreviewed(root)).toBe(true);
  });

  test("BR-2354: a decision pointing at one the overview does not name, a link that was already there, a backticked id and an empty overview report nothing", () => {
    const other = fixture();
    amend(other, id("D", 7));
    expect(unreviewed(other)).toBe(false);
    const before = fixture();
    amend(before);
    commit(before);
    put(before, { "src/billing/x.txt": "x" });
    expect(unreviewed(before)).toBe(false);
    const code = fixture("## 容器\n\n- `src/billing`；编号写成 `D-5`。\n");
    amend(code);
    expect(unreviewed(code)).toBe(false);
    const empty = fixture("");
    amend(empty);
    expect(unreviewed(empty)).toBe(false);
  });

  test("BR-2354: a landing that amends a named decision without touching the overview is refused for check; saying so in its change file lands it", async () => {
    const root = fixture();
    const s = startNew(root, "Amend D-5");
    amend(s.worktree);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "amend");
    const refused = await land(ws(s.worktree), FAST, () => {});
    expect(refused.kind === "refused" && refused.reason).toBe("check");
    expect(JSON.stringify(refused)).toContain("architecture-unreviewed");
    const file = join(s.worktree, "canon/changes", readdirSync(join(s.worktree, "canon/changes")).find((f) => f.startsWith(s.change))!);
    const text = (await Bun.file(file).text()).replace("## 任务", "总览不受影响：D-9 只改了评审的措辞\n\n## 任务");
    writeFileSync(file, text);
    sh(s.worktree, "commit", "-qam", "say it");
    const out = await land(ws(s.worktree), FAST, () => {});
    expect(JSON.stringify(out)).not.toContain("refused");
    expect(out.kind).toBe("landed");
  });
});

describe("the overview's backticked paths are checked like other current documents", () => {
  test("BR-2171: a deleted path written in canon/architecture.md is reported as path-missing at the overview", () => {
    const root = fixture("## 容器\n\n- `src/billing` 和 `src/old.ts`\n");
    put(root, { "src/old.ts": "x\n" });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "old");
    sh(root, "rm", "-q", "src/old.ts");
    sh(root, "commit", "-qm", "gone");
    const r = canon(root, "check");
    expect(r.out).toContain(`path-missing`);
    expect(r.out).toContain(`${OVERVIEW}: names \`src/old.ts\``);
  });
});
