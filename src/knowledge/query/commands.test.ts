import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";

/** `canon show`, `search` and `context` driven through the real command line. */
const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const RULE = (n: number, title: string, body: string) => `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: active\nuntested: fixture\n---\n${body}\n`;

/** auth with BR-3 "Session length", and `notes` notes N-1.. that each contain "sessions". */
function fixture(notes = 0, extra: Record<string, string> = {}) {
  const root = project();
  const files: Record<string, string> = {
    "canon/rules/auth/README.md": "---\ncode: [src/auth]\n---\n# auth\n\n## 术语\n\n- **会话**：登录状态\n",
    [`canon/rules/auth/${id("BR", 3)}.md`]: RULE(3, "Session length", "Sessions last 12 hours."),
    ...Object.fromEntries(Array.from({ length: notes }, (_, i) => [`canon/notes/${id("N", i + 1)}.md`, `---\nid: ${id("N", i + 1)}\ntitle: Note ${i + 1}\n---\nAbout sessions.\n`])),
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  mkdirSync(join(root, "src/auth"), { recursive: true });
  writeFileSync(join(root, "src/auth/.keep"), "");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const searchEvents = (root: string) => ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'search' ORDER BY id").all().map((r) => JSON.parse(r.detail) as { results: number });

describe("search --limit", () => {
  test("BR-2212: at most --limit results, 20 by default, and the search event counts what was listed", () => {
    const root = fixture(25);
    const all = JSON.parse(canon(root, "search", "sessions", "--json").out) as unknown[];
    expect(all.length).toBe(20);
    const one = canon(root, "search", "sessions", "--limit", "1");
    expect(one.code).toBe(0);
    expect(one.out.split("\n").filter((l) => /^\S/.test(l)).length).toBe(1);
    expect(searchEvents(root).map((e) => e.results)).toEqual([20, 1]); // BR-2134: results is what --limit let through
  });

  test("BR-2212: a --limit that is not a positive integer is a usage error before anything is searched or recorded", () => {
    const root = fixture(2);
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      const r = canon(root, "search", "sessions", `--limit=${bad}`);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--limit");
      expect(r.err).toContain(JSON.stringify(bad));
      expect(r.out).not.toContain("(no match)");
    }
    expect(searchEvents(root)).toEqual([]);
  });
});

describe("search output", () => {
  test("BR-2214: each result shows the id, the title and the first body line holding a query word; --json gives the same fields", () => {
    const long = `A long line about refunds ${"y".repeat(200)}`;
    const root = fixture(0, {
      [`canon/decisions/${id("D", 1)}.md`]: `---\nid: ${id("D", 1)}\ntitle: Refund policy\nstatus: accepted\n---\nFirst line.\n\nBecause of money.\n`,
      [`canon/notes/${id("N", 1)}.md`]: `---\nid: ${id("N", 1)}\ntitle: Long\n---\nIntro.\n${long}\n`,
    });
    const out = canon(root, "search", "hours").out.split("\n");
    expect(out.slice(0, 2)).toEqual([`${id("BR", 3)}     Session length`, "         Sessions last 12 hours."]);
    const refunds = canon(root, "search", "refund").out;
    expect(refunds).toContain(`${id("N", 1)}      Long\n         ${long.slice(0, 160)}\n`);
    expect(refunds).toContain(`${id("D", 1)}      Refund policy\n         First line.\n`); // title only: the body's first line
    expect(JSON.parse(canon(root, "search", "hours", "--json").out)).toEqual([
      { id: id("BR", 3), kind: "rule", title: "Session length", path: `canon/rules/auth/${id("BR", 3)}.md`, line: "Sessions last 12 hours.", matched: 1, terms: 1 },
    ]);
  });

  test("BR-2133: --json output carries no hint, even when no document has every word", () => {
    const root = fixture();
    const r = canon(root, "search", "sessions zzqq", "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { matched: number; terms: number }[]).map((h) => [h.matched, h.terms])).toEqual([[1, 2]]);
    expect(r.out).not.toContain("Chinese keywords");
    expect(canon(root, "search", "zzqq", "--json").out.trim()).toBe("[]");
  });
});

describe("show", () => {
  test("BR-2213: show prints the path, a blank line and the raw file; ids are case-insensitive; a missing id prints nothing and exits 3", () => {
    const root = fixture();
    const r = canon(root, "show", id("BR", 3));
    expect(r.code).toBe(0);
    expect(r.out).toBe(`canon/rules/auth/${id("BR", 3)}.md\n\n${RULE(3, "Session length", "Sessions last 12 hours.")}`);
    expect(canon(root, "show", id("br", 3))).toEqual(r);
    const missing = canon(root, "show", id("BR", 999));
    expect(missing.code).toBe(3);
    expect(missing.out).toBe("");
  });

  test("BR-2140: show adds no amended line when the only amending decision is superseded", () => {
    const dec = (n: number, status: string, extra = "") => `---\nid: ${id("D", n)}\ntitle: Decision ${n}\nstatus: ${status}\n${extra}---\nAbout ${id("BR", 3)}.\n`;
    const root = fixture(0, {
      [`canon/decisions/${id("D", 9)}.md`]: dec(9, "accepted"),
      [`canon/decisions/${id("D", 12)}.md`]: dec(12, "superseded", `amends: [${id("D", 9)}]\n`),
    });
    const r = canon(root, "show", id("D", 9));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("partly amended by");
    expect(canon(root, "context", id("D", 9)).out).not.toContain("partly amended by");
  });
});
