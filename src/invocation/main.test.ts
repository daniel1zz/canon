import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guideFor, WORKFLOW_GUIDE } from "./guide.ts";

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
    const change = canon(root, "change", "new", "--title", "Template check").out.trim(); // after the C-1 assertions above
    expect(readFileSync(join(root, change), "utf8")).toContain("## 陷阱和假设");
    const template = readFileSync(join(root, change), "utf8");
    expect(template.indexOf("## 教训")).toBeGreaterThan(template.indexOf("## 陷阱和假设")); // BR-2037: lessons before the tasks
    expect(template.indexOf("## 教训")).toBeLessThan(template.indexOf("## 任务"));
    expect(template).toContain("本变更为自己的功能或修复写的规则、测试和检查不是教训"); // BR-2037, D-78
  });

  test("BR-2037 BR-2110: a new decision's template has a 来源 line under each option; filled in it passes canon check, left as is it is refused", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    writeFileSync(join(root, "notes.txt"), "the original sentence quoted here\n");
    const path = canon(root, "decision", "new", "--title", "Use files").out.trim();
    const template = readFileSync(join(root, path), "utf8");
    const placeholder = "   - 来源：<网址或仓库里的文件路径> “<原文摘录，至少 8 个字符>”";
    expect(template.split(placeholder).length - 1).toBe(2); // one line under each of the two options
    expect(template.indexOf(placeholder)).toBeGreaterThan(template.indexOf("1. <方案一>"));
    expect(canon(root, "check").out).toContain("template-unfilled"); // unfilled placeholder: refused
    const filled = template
      .replace("<为什么需要做这个决定，有哪些事实和数据。>", "Because.")
      .replace("<方案一>：<采用或否决，以及理由>", "Files：采用，简单")
      .replace("<方案二>：<采用或否决，以及理由>", "Database：否决，太重")
      .replace(placeholder, "   - 来源：notes.txt “the original sentence quoted here”")
      .replace(placeholder, "   - 来源：notes.txt “the original sentence quoted here”")
      .replace("<决定了什么。>", "Files.")
      .replace("<带来哪些变化、代价和后续工作。>", "None.");
    writeFileSync(join(root, path), filled);
    const r = canon(root, "check");
    expect(r.out).not.toContain("source-malformed");
    expect(r.out).not.toContain("template-unfilled");
  });

  test("BR-2037: a rule created without a body holds the template, which canon check reports until it is filled", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "rule", "domain", "billing", "--code", "src/billing", "--description", "Money.");
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 术语\n\n- **退款**：钱退回\n");
    canon(root, "rule", "new", "--domain", "billing", "--title", "Refunds", "--untested", "fixture");
    const id = ["BR", 1].join("-");
    const shown = canon(root, "show", id).out;
    expect(shown).toContain("## 规则");
    expect(shown).toContain("## 例子");
    expect(canon(root, "check").out).toContain(`template-unfilled  canon/rules/billing/${id}.md`);
  });

  test("BR-2048: a --timeout that is not a positive number is a usage error and never enters the queue", () => {
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

  test("BR-2021: without a terminal and without --relayed an answer is refused; an agent relaying the human's words is recorded as a relay", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    expect(canon(root, "human", "ask", "Ship it?").code).toBe(0);
    const bare = canon(root, "human", "answer", "1", "yes");
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("--relayed");
    const relayed = canon(root, "human", "answer", "1", "yes", "--relayed", "好的，发吧");
    expect(relayed.code).toBe(0);
    expect(canon(root, "human", "pending", "--all").out).toContain('→ yes (agent:test relaying the human: "好的，发吧")');
    expect(canon(root, "human", "answer", "1", "no", "--relayed", "算了").code).toBe(5); // answered once (BR-2040)
  });
});

function committed(root: string) {
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "c"], { cwd: root });
}

describe("search events", () => {
  test("BR-2134 BR-2135: each search records its query, results and full matches; canon stats reports them", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "note", "new", "--title", "sessions last hours");
    committed(root);
    expect(canon(root, "stats").out).not.toContain("searches:");
    canon(root, "search", "sessions hours");
    canon(root, "search", "sessions zzqq");
    const none = canon(root, "search", "zzqq", "--json");
    expect(JSON.parse(none.out)).toEqual([]);
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(join(root, ".git/canon/state.db"), { readonly: true });
    const rows = db.query<{ subject: string | null; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'search' ORDER BY id").all();
    db.close();
    expect(rows.map((r) => r.subject)).toEqual([null, null, null]);
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { query: "sessions hours", results: 1, full: 1 },
      { query: "sessions zzqq", results: 1, full: 0 },
      { query: "zzqq", results: 0, full: 0 },
    ]);
    expect(canon(root, "stats").out).toContain("searches: 3, no result: 1 (33.3%), no full match: 2 (66.7%)");
  });
});

describe("event windows", () => {
  test("BR-2154 BR-2155 BR-2156: --since must be an event id; stats --json gains since, checks and window only with it; events prints rows, newest last", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "search", "anything");
    const all = JSON.parse(canon(root, "events", "--json").out) as { id: number; kind: string; detail: unknown }[];
    expect(all.length).toBeGreaterThan(0);
    const last = all.at(-1)!;
    expect(last.kind).toBe("search");
    expect(typeof last.detail).toBe("object");
    expect(canon(root, "events", "--since", String(last.id)).out.trim()).toBe("(no events)");
    expect(canon(root, "events", "--since", String(last.id - 1), "--kind", "search").out.trim()).toMatch(new RegExp(`^#${last.id} .* search - \\{`));
    for (const bad of ["x", "1.5"]) {
      const r = canon(root, "events", "--since", bad);
      expect([r.code, r.err.includes("--since must be an event id")]).toEqual([2, true]);
      expect(canon(root, "stats", "--since", bad).code).toBe(2);
    }
    expect(canon(root, "events", "--since", "-1").code).toBe(2);
    expect(Array.isArray(JSON.parse(canon(root, "stats", "--json").out))).toBe(true);
    const windowed = JSON.parse(canon(root, "stats", "--json", "--since", String(last.id)).out) as { since: number; checks: unknown[]; window: { events: number } };
    expect([windowed.since, Array.isArray(windowed.checks), windowed.window.events]).toEqual([last.id, true, 0]);
    expect(canon(root, "stats", "--since", "0").out).toContain("window: events after #0");
    expect(canon(root, "stats").out).not.toContain("window:");
  });
});

describe("undeclared arguments", () => {
  test("BR-2097 BR-2022: an option or positional the command does not declare exits 2, names it and lists the valid options", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const typo = canon(root, "search", "brief", "--jsno");
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("--jsno");
    expect(typo.err).toContain("--limit, --json");
    expect(canon(root, "search", "brief", "--json").code).toBe(0);
    expect(canon(root, "stats", "extra").code).toBe(2);
    const extra = canon(root, "search", "a", "b");
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('"b"');
    expect(canon(root, "show", ["C", 1].join("-"), "--json").code).toBe(2);
    expect(canon(root, "stats", "--json=yes").code).toBe(2);
    expect(canon(root, "stats", "--json=true").code).toBe(0);
    expect(canon(root, "work", "land", "--dry-run").code).toBe(2);
  });

  test("BR-2097: a write command with an unknown option changes nothing; without it, it writes", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    canon(root, "rule", "domain", "billing", "--code", "src/billing");
    const before = readdirSync(join(root, "canon/rules/billing")).sort();
    const r = canon(root, "rule", "new", "--domain", "billing", "--title", "X", "--dry-run");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--dry-run");
    expect(readdirSync(join(root, "canon/rules/billing")).sort()).toEqual(before);
    expect(canon(root, "rule", "new", "--domain", "billing", "--title", "X").code).toBe(0);
    expect(readdirSync(join(root, "canon/rules/billing")).length).toBe(before.length + 1);
  });

  test("BR-2097: the check runs before the command touches the repository, and --help still prints usage", () => {
    const outside = mkdtempSync(join(tmpdir(), "canon-not-a-repo-"));
    expect(canon(outside, "stats", "--bogus").code).toBe(2); // not 4: nothing looked for a repository
    const h = canon(outside, "stats", "--bogus", "--help");
    expect(h.code).toBe(0);
    expect(h.out + h.err).toContain("USAGE");
  });

  test("BR-2097: a group that cannot run by itself, given an option and no subcommand, exits 2", () => {
    const r = canon(mkdtempSync(join(tmpdir(), "canon-not-a-repo-")), "decision", "--bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("canon decision --help");
  });
});

describe("help", () => {
  test("BR-2101: help names the command by canon and the words that named it, never by the executable's path", () => {
    const root = repo();
    const sub = canon(root, "rule", "--help");
    expect(sub.code).toBe(0);
    expect(sub.out).toContain("USAGE canon rule new|list|retire|domain|domains");
    expect(sub.out).toContain("Use canon rule <command> --help");
    expect(sub.out).not.toContain("main.ts");
    expect(canon(root, "rule", "new", "--help").out).toContain("USAGE canon rule new [OPTIONS]");
    expect(canon(root, "--help").out).toContain("USAGE canon init|");
  });
});

describe("help after --", () => {
  test("BR-2194: --help and -h print usage only before --; after it they are positional arguments", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const help = canon(root, "search", "--help");
    expect([help.code, help.out]).toEqual([0, expect.stringContaining("USAGE canon search")]);
    const searched = canon(root, "search", "--", "--help");
    expect(searched.code).toBe(0);
    expect(searched.out).not.toContain("USAGE");
    const extra = canon(root, "stats", "--", "-h");
    expect([extra.code, extra.out, extra.err]).toEqual([2, "", expect.stringContaining('unexpected "-h"')]);
  });
});

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

  test("BR-2032: the config init writes starts with the modeline that points editors at the schema and sets a working reviewer", () => {
    const root = repo();
    canon(root, "init", "--floor", "bun test");
    const lines = readFileSync(join(root, "canon/config.yaml"), "utf8").split("\n");
    expect(lines[0]).toBe("# yaml-language-server: $schema=../.canon/config.schema.json");
    expect(lines).toContain('floor: "bun test"');
    const review = lines.indexOf('review: "claude -p --model sonnet --output-format text"');
    expect(review).toBeGreaterThan(0);
    expect(lines[review - 1]).toStartWith("#"); // the comment says what it reviews and how to turn it off
    expect(lines[review - 1]).toContain("review: none");
    expect(canon(root, "config").out).toContain('review = "claude -p --model sonnet --output-format text"');
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

  test("BR-2027: a decision whose supersedes is a list supersedes every listed decision; any other shape is refused and changes nothing", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const d = (n: number) => ["D", n].join("-");
    const file = (n: number) => join(root, "canon/decisions", readdirSync(join(root, "canon/decisions")).find((f) => f.startsWith(`${d(n)}-`))!);
    for (const t of ["Old one", "Old two", "New way"]) canon(root, "decision", "new", "--title", t);
    for (const n of [1, 2]) expect(canon(root, "decision", "accept", d(n)).code).toBe(0);
    const set = (value: string) => writeFileSync(file(3), readFileSync(file(3), "utf8").replace(/^supersedes:.*\n/m, "").replace("status: proposed", `supersedes: ${value}\nstatus: proposed`));
    for (const bad of ["[]", "5", "{a: 1}", `[${d(1)}, 7]`, `[${d(1)}, nope]`]) {
      set(bad);
      const c = canon(root, "check");
      expect(c.code).toBe(1);
      expect(c.out).toContain(file(3).slice(root.length + 1));
      expect(c.out).toContain("`supersedes`");
      const a = canon(root, "decision", "accept", d(3));
      expect(a.code).toBe(1);
      expect(a.err).toContain("`supersedes`");
      expect(readFileSync(file(1), "utf8")).toContain("status: accepted");
      expect(readFileSync(file(3), "utf8")).toContain("status: proposed");
    }
    set(`[${d(1)}, ${d(2)}]`);
    const ok = canon(root, "decision", "accept", d(3));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`${d(1)} → superseded`);
    expect(ok.out).toContain(`${d(2)} → superseded`);
    const list = canon(root, "decision", "list", "--all").out;
    expect(list).toMatch(/D-1\s+superseded/);
    expect(list).toMatch(/D-2\s+superseded/);
    expect(list).toMatch(/D-3\s+accepted/);
  });

  test("BR-2140: show ends with the accepted decisions that amend a decision, and not a proposed one", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const d = (n: number) => ["D", n].join("-");
    canon(root, "decision", "new", "--title", "Old way");
    canon(root, "decision", "new", "--title", "Part change");
    const path = join(root, "canon/decisions", readdirSync(join(root, "canon/decisions")).find((f) => f.startsWith(`${d(2)}`))!);
    writeFileSync(path, readFileSync(path, "utf8").replace("status: proposed", `amends: [${d(1)}]\nstatus: proposed`));
    expect(canon(root, "show", d(1)).out).not.toContain("partly amended by");
    expect(canon(root, "decision", "accept", d(2)).code).toBe(0);
    const out = canon(root, "show", d(1)).out.trimEnd().split("\n");
    expect(out.at(-1)).toBe(`partly amended by ${d(2)} Part change (${path.slice(root.length + 1)})`);
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

  test("BR-2163: stop and land --finish end with the lessons reminder; land without --finish does not", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const last = (out: string) => out.trim().split("\n").pop()!;
    const fill = (wt: string, change: string) => {
      const dir = join(wt, "canon/changes");
      const name = readdirSync(dir).find((f) => f === `${change}.md` || f.startsWith(`${change}-`))!;
      const text = readFileSync(join(dir, name), "utf8");
      writeFileSync(join(dir, name), `${text.slice(0, text.indexOf("---\n", 4) + 4)}\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 教训\n\n无。\n\n## 任务\n\n- [x] x\n`);
      Bun.spawnSync(["git", "commit", "-qam", "fill"], { cwd: wt });
    };
    const one = canon(root, "work", "start", "--title", "One").out.match(/cd (.+)/)![1]!.trim();
    const stopped = canon(one, "work", "stop", "--next", "write the test");
    expect(stopped.code).toBe(0);
    expect(last(stopped.out)).toMatch(/^lessons: .*## 教训.*ask the owner.*not lessons/);
    fill(one, ["C", 1].join("-"));
    const plain = canon(one, "work", "land");
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain("lessons:");
    const finished = canon(one, "work", "land", "--finish");
    expect(finished.code).toBe(0);
    expect(last(finished.out)).toBe(last(stopped.out));
  });

  test("BR-2024: in a claimed worktree brief shows only its own change; other handoffs and the question count only where nothing is claimed", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const wt = (title: string) => canon(root, "work", "start", "--title", title).out.match(/cd (.+)/)![1]!.trim();
    const a = wt("A");
    const b = wt("B");
    expect(canon(b, "work", "stop", "--next", "finish B").code).toBe(0);
    expect(canon(a, "work", "stop", "--next", "finish A").code).toBe(0);
    expect(canon(root, "human", "ask", "which way?").code).toBe(0);
    const inA = canon(a, "brief").out;
    expect(inA).toContain("You are in C-1");
    expect(inA).toContain("next — finish A");
    expect(inA).not.toContain("C-2");
    expect(inA).not.toContain("Unfinished changes with handoffs");
    expect(inA).not.toContain("wait for a human");
    const inMain = canon(root, "brief").out;
    expect(inMain).toContain("Unfinished changes with handoffs: C-1, C-2");
    expect(inMain).toContain("1 question(s) wait for a human");
    expect(inMain).not.toContain("You are in");
  });

  test("BR-2024 BR-2090: with nothing in flight brief prints only the workflow guide, and the guide comes first otherwise", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    const idle = canon(root, "brief").out;
    expect(idle.trim()).toBe(guideFor(root)); // init wrote canon/architecture.md, so the guide starts with the overview line (BR-2090)
    for (const cmd of ["canon context", "canon work start", "canon work land --finish", "canon work stop --next", "--relayed", "canon work drop", "canon work after-land --wait", "canon-product"]) expect(idle).toContain(cmd);
    committed(root);
    const wt = canon(root, "work", "start", "--title", "Refunds").out.match(/cd (.+)/)![1]!.trim();
    const b = canon(wt, "brief").out;
    expect(b.startsWith(guideFor(root))).toBe(true);
    expect(b.slice(guideFor(root).length)).toContain("You are in C-1");
  });
});

describe("brief when it cannot read the project", () => {
  test("BR-2090: outside a repository and with a broken config, brief still prints the guide first and its error on stdout", () => {
    const outside = mkdtempSync(join(tmpdir(), "canon-not-a-repo-"));
    const r = canon(outside, "brief");
    expect(r.code).toBe(4);
    expect(r.out.startsWith(WORKFLOW_GUIDE)).toBe(true);
    const after = r.out.slice(WORKFLOW_GUIDE.length);
    expect(after).toContain("canon brief failed:");
    expect(after).toContain("not a git repository");
    expect(after).toContain("run canon brief again");
    expect(r.err).toContain("not a git repository");
    const root = repo();
    canon(root, "init", "--floor", "true");
    writeFileSync(join(root, "canon/config.yaml"), "main: [\n");
    const bad = canon(root, "brief");
    expect(bad.code).toBe(2);
    expect(bad.out.startsWith(guideFor(root))).toBe(true);
    expect(bad.out.slice(guideFor(root).length)).toContain("canon brief failed:");
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
  test("BR-2102 BR-2103 BR-2022: drop that would lose work archives it and exits 0 printing how to restore; a failed archive exits 4", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    committed(root);
    const wt = canon(root, "work", "start", "--title", "Risky").out.match(/cd (.+)/)![1]!.trim();
    writeFileSync(join(wt, "wip.txt"), "wip");
    expect(canon(wt, "work", "stop", "--release", "--next", "drop it").code).toBe(0); // a live claim refuses the drop (BR-2064)
    Bun.spawnSync(["git", "update-ref", "refs/canon/archive/C-1", "HEAD"], { cwd: root });
    const blocked = canon(root, "work", "drop", "C-1");
    expect(blocked.code).toBe(4);
    expect(Bun.spawnSync(["test", "-d", wt]).exitCode).toBe(0);
    Bun.spawnSync(["git", "update-ref", "-d", "refs/canon/archive/C-1"], { cwd: root });
    const r = canon(root, "work", "drop", "C-1");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/archived to refs\/canon\/archive\/C-1\//);
    expect(r.out).toContain("uncommitted: ?? wip.txt");
    expect(r.out).toContain("restore --source=refs/canon/archive/C-1/");
    expect(Bun.spawnSync(["test", "-d", wt]).exitCode).toBe(1);
  });
});

describe("subdomains from the CLI", () => {
  test("BR-2115: a subdomain is created only under an existing domain, names no code, and every segment must be a valid name", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/refund.ts"), "");
    expect(canon(root, "rule", "domain", "billing/refunds").code).toBe(3);
    expect(existsSync(join(root, "canon/rules/billing"))).toBe(false);
    expect(canon(root, "rule", "domain", "billing").code).toBe(2); // a top-level domain without code_root needs --code
    expect(canon(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(0);
    expect(readFileSync(join(root, "canon/rules/billing/README.md"), "utf8")).toStartWith("---\ncode:\n  - src/billing\n---\n");
    expect(canon(root, "rule", "domain", "billing/refunds", "--code", "src/billing/refund.ts").code).toBe(2);
    expect(existsSync(join(root, "canon/rules/billing/refunds"))).toBe(false);
    expect(canon(root, "rule", "domain", "billing/refunds").code).toBe(0);
    expect(readFileSync(join(root, "canon/rules/billing/refunds/README.md"), "utf8")).toStartWith("# billing/refunds");
    expect(canon(root, "rule", "domain", "Billing/x").code).toBe(2);
    expect(canon(root, "rule", "new", "--domain", "billing/refunds", "--title", "Refund window", "--untested", "fixture").code).toBe(0);
    expect(canon(root, "rule", "list", "--domain", "billing").out).toContain("Refund window"); // a domain's list includes its subdomains
    expect(canon(root, "check").out).not.toContain("domain-code-declared");
  });

  test("BR-2115: with code_root a top-level domain takes no --code and is told its directory", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}code_root: src\n`);
    expect(canon(root, "rule", "domain", "billing", "--code", "src/billing").code).toBe(2);
    const r = canon(root, "rule", "domain", "billing");
    expect(r.code).toBe(0);
    expect(r.out).toContain("code: src/billing");
    expect(readFileSync(join(root, "canon/rules/billing/README.md"), "utf8")).toStartWith("# billing");
    // BR-2115: a name ending in a technical-layer word is created all the same, with a hint (BR-2317)
    expect([canon(root, "rule", "domain", "config").code, existsSync(join(root, "canon/rules/config/README.md"))]).toEqual([0, true]);
  });

  test("BR-2317: a domain named after a technical layer is still created, exit 0, with a hint naming the word; other names get none", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    const ok = canon(root, "rule", "domain", "billing", "--code", "src/billing");
    expect([ok.code, ok.out.includes("hint:")]).toEqual([0, false]);
    const sub = canon(root, "rule", "domain", "billing/api");
    expect(sub.code).toBe(0);
    expect(existsSync(join(root, "canon/rules/billing/api/README.md"))).toBe(true);
    expect(sub.out).toMatch(/hint: .*`api`.*business capability.*canon-domains/);
    const joined = canon(root, "rule", "domain", "billing/billing-api");
    expect([joined.code, joined.out.includes("hint:")]).toEqual([0, false]);
    writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}code_root: src\n`);
    const cfg = canon(root, "rule", "domain", "config");
    expect(cfg.code).toBe(0);
    expect(cfg.out).toMatch(/hint: .*`config`/);
  });

  test("BR-2318: check says a technical-layer domain name as a note on stderr, not a finding; rule domains says it beside the domain", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    for (const d of ["billing", "config"]) {
      mkdirSync(join(root, "src", d), { recursive: true });
      canon(root, "rule", "domain", d, "--code", `src/${d}`);
      writeFileSync(join(root, `canon/rules/${d}/README.md`), `---\ncode: [src/${d}]\n---\n# ${d}\n\nX.\n\n## 术语\n\n- **退款**：钱退回\n`);
    }
    const c = canon(root, "check");
    expect([c.code, c.out.startsWith("ok: ")]).toEqual([0, true]);
    expect(c.err).toMatch(/note: canon\/rules\/config\/README\.md: .*`config`/);
    expect(c.err).not.toContain("billing/README");
    expect(canon(root, "check", "--json").out.trim()).toBe("[]");
    const dom = canon(root, "rule", "domains").out.split("\n");
    expect(dom.find((l) => l.startsWith("config"))).toContain("named after a technical layer");
    expect(dom.find((l) => l.startsWith("billing"))).not.toContain("named after a technical layer");
    mkdirSync(join(root, "src/billing/api"), { recursive: true });
    canon(root, "rule", "domain", "billing/api");
    writeFileSync(join(root, "canon/rules/billing/api/README.md"), "# api\n\n## 术语\n\n- **退款**：钱退回\n");
    const sub = canon(root, "check");
    expect(sub.code).toBe(0);
    expect(sub.err).toMatch(/note: canon\/rules\/billing\/api\/README\.md: .*`api`/);
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nX.\n");
    const noTerms = canon(root, "check");
    expect(noTerms.code).toBe(1);
    expect(noTerms.out).toContain("doc-missing-section");
  });

  test("BR-2114: rule domains indents subdomains and suggests splitting only above 25 direct rules", () => {
    const root = repo();
    canon(root, "init", "--floor", "true");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    canon(root, "rule", "domain", "billing", "--code", "src/billing");
    canon(root, "rule", "domain", "billing/refunds");
    expect(canon(root, "rule", "domains").out.split("\n").find((l) => l.includes("billing/refunds"))).not.toContain("technical layer");
    // reason: written directly, not by 26 `rule new` processes, which outran the 5 s test timeout under load
    let next = 1;
    const add = (n: number) => {
      for (let i = 0; i < n; i++, next++) {
        const rid = ["BR", next].join("-");
        writeFileSync(join(root, `canon/rules/billing/${rid}.md`), `---\nid: ${rid}\ntitle: R${next}\nstatus: active\nuntested: fixture\n---\n## 规则\n\nX.\n`);
      }
    };
    add(25);
    let out = canon(root, "rule", "domains").out;
    expect(out).toMatch(/\n?billing\s+25 rules/);
    expect(out).toMatch(/\n  billing\/refunds\s+0 rules/);
    expect(out).not.toContain("consider subdomains");
    add(1);
    out = canon(root, "rule", "domains").out;
    expect(out).toContain("consider subdomains, canon rule domain billing/<name>");
  });
});
