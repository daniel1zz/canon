import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh } from "../testkit.ts";
import { fixedIn } from "./issues.ts";

// reason: each case spawns canon, which spawns git and the fake gh; under load a spawn can take seconds (C-111)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const GIT = Bun.which("git")!;
const change = (n: number) => ["C", n].join("-");

/**
 * A PATH holding only git and, unless `gh` is false, a fake gh: `issue list` prints issues.json (or fails with
 * list.err), `auth status` exits with the code in auth.code; every call is appended to calls.log.
 */
function fakePath(opts: { gh: boolean; issues?: unknown; raw?: string; listErr?: string; authCode?: number }) {
  const bin = mkdtempSync(join(tmpdir(), "canon-fake-gh-"));
  symlinkSync(GIT, join(bin, "git"));
  if (opts.gh) {
    writeFileSync(join(bin, "issues.json"), opts.raw ?? JSON.stringify(opts.issues ?? []));
    const script = [
      "#!/bin/sh",
      `echo "$*" >> ${bin}/calls.log`,
      'if [ "$1 $2" = "auth status" ]; then',
      `  exit ${opts.authCode ?? 0}`,
      "fi",
      'if [ "$1 $2" = "issue list" ]; then',
      opts.listErr ? `  echo "${opts.listErr}" >&2; exit 1` : `  /bin/cat ${bin}/issues.json; exit 0`,
      "fi",
      "exit 9",
    ].join("\n");
    writeFileSync(join(bin, "gh"), `${script}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  }
  return bin;
}

function canon(cwd: string, path: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PATH: path, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function commit(root: string, subject: string, body = "") {
  writeFileSync(join(root, "app.txt"), `${subject}\n`);
  sh(root, "commit", "-qam", body ? `${subject}\n\n${body}` : subject);
}

const issue = (number: number, title: string) => ({ number, title, url: `https://github.com/o/r/issues/${number}` });

describe("canon issues", () => {
  test("BR-2168: open issues are listed newest first with the commits on main that name them as fixed", () => {
    const root = project();
    commit(root, `canon: open ${change(117)} 撤回关闭提交（#34）`);
    commit(root, `Take the close commit back by a compare-and-swap on HEAD (${change(117)}, #34)`);
    const bin = fakePath({ gh: true, issues: [issue(29, "abandoned entry"), issue(34, "reopen drops a commit")] });
    const r = canon(root, bin, "issues");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("#34  reopen drops a commit");
    expect(lines[1]).toMatch(/^ {4}named as fixed on main by [0-9a-f]{9} Take the close commit back/);
    expect(lines[2]).toBe("#29  abandoned entry");
    expect(lines[3]).toBe("    open: no commit on main names it as fixed");
    expect(r.out).toContain("2 open issue(s); 1 named as fixed by a commit on main: #34");
    expect(r.out).toContain("gh issue close");
    // read only: gh was asked to list, nothing else, and auth status only runs when the list fails (BR-2170)
    expect(readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n")).toEqual(["issue list --state open --limit 1000 --json number,title,url"]);
  });

  test("BR-2168: no open issues gives only the summary, and --json carries the same facts", () => {
    const root = project();
    const empty = canon(root, fakePath({ gh: true, issues: [] }), "issues");
    expect(empty.code).toBe(0);
    expect(empty.out.trim()).toBe("0 open issue(s); 0 named as fixed by a commit on main");
    commit(root, "Pick the batch by landing order", `(${change(105)}, fixes #28)`);
    const j = canon(root, fakePath({ gh: true, issues: [issue(28, "batch")] }), "issues", "--json");
    const parsed = JSON.parse(j.out) as { number: number; fixedBy: { subject: string }[] }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.number).toBe(28);
    expect(parsed[0]!.fixedBy.map((c) => c.subject)).toEqual(["Pick the batch by landing order"]);
  });

  test("BR-2225: reading exactly 1000 open issues says in the summary that more may be open; 999 does not", () => {
    const root = project();
    const many = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1, `issue ${i + 1}`));
    const full = canon(root, fakePath({ gh: true, issues: many(1000) }), "issues");
    expect(full.code).toBe(0);
    expect(full.out.trimEnd().split("\n").at(-1)).toBe("1000 open issue(s) (the most canon reads; more may be open and are not listed); 0 named as fixed by a commit on main");
    const below = canon(root, fakePath({ gh: true, issues: many(999) }), "issues");
    expect(below.out.trimEnd().split("\n").at(-1)).toBe("999 open issue(s); 0 named as fixed by a commit on main");
    expect(below.out + below.err).not.toContain("more may be open");
    const j = canon(root, fakePath({ gh: true, issues: many(1000) }), "issues", "--json");
    expect((JSON.parse(j.out) as unknown[]).length).toBe(1000);
    expect(j.err).toContain("more may be open and are not listed");
    const jBelow = canon(root, fakePath({ gh: true, issues: many(999) }), "issues", "--json");
    expect(jBelow.err).not.toContain("more may be open");
  });

  test("BR-2169: closing keywords and change groups name a fix; the opening commit and bare mentions do not", () => {
    expect(fixedIn(`Take the close commit back (${change(117)}, #34)`, "C")).toEqual([34]);
    expect(fixedIn(`canon brief picks the latest batch (${change(105)}, fixes #28)`, "C")).toEqual([28]);
    expect(fixedIn("Subject\n\nFixes: #3", "C")).toEqual([3]);
    expect(fixedIn("closes #4 and resolved #5", "C")).toEqual([4, 5]);
    expect(fixedIn(`Work (${change(9)}，#7)`, "C")).toEqual([7]);
    expect(fixedIn(`Work（${change(9)}, #8）`, "C")).toEqual([8]);
    expect(fixedIn(`canon: open ${change(117)} 撤回（#34）`, "C")).toEqual([]);
    expect(fixedIn(`canon: open ${change(117)} x (${change(117)}, #34)`, "C")).toEqual([]);
    expect(fixedIn("see #12 for background", "C")).toEqual([]);
    expect(fixedIn("Something (#12)", "C")).toEqual([]);
    expect(fixedIn("prefix#12 fixes#13", "C")).toEqual([]);
  });

  test("BR-2170: gh missing from PATH exits 4 and lists nothing", () => {
    const r = canon(project(), fakePath({ gh: false }), "issues");
    expect(r.code).toBe(4);
    expect(r.err).toContain("not installed or not on PATH");
    expect(r.out).not.toContain("open issue(s)");
  });

  test("BR-2170: gh not authenticated exits 4 and says to run gh auth login", () => {
    const r = canon(project(), fakePath({ gh: true, listErr: "HTTP 401: Bad credentials", authCode: 1 }), "issues");
    expect(r.code).toBe(4);
    expect(r.err).toContain("gh is not authenticated: run gh auth login");
    expect(r.out).not.toContain("open issue(s)");
  });

  test("BR-2170: another gh failure exits 4 with gh's own message", () => {
    const bin = fakePath({ gh: true, listErr: "no git remotes found", authCode: 0 });
    const r = canon(project(), bin, "issues");
    expect(r.code).toBe(4);
    expect(r.err).toContain("no git remotes found");
    expect(r.out).not.toContain("open issue(s)");
    expect(existsSync(join(bin, "calls.log"))).toBe(true);
  });

  test("BR-2206: each commit naming an issue as fixed has its own line, newest first; --json has exactly number, title, url and fixedBy", () => {
    const root = project();
    commit(root, `Fix part (${change(1)}, #5)`);
    commit(root, `Fix rest (${change(2)}, #5)`);
    const bin = fakePath({ gh: true, issues: [issue(5, "two fixes"), issue(7, "none yet")] });
    const lines = canon(root, bin, "issues").out.split("\n");
    expect(lines.slice(0, 3).map((l) => l.replace(/[0-9a-f]{9}/, "<sha>"))).toEqual([
      "#7  none yet",
      "    open: no commit on main names it as fixed",
      "#5  two fixes",
    ]);
    expect(lines.slice(3, 5).map((l) => l.replace(/[0-9a-f]{9}/, "<sha>"))).toEqual([
      `    named as fixed on main by <sha> Fix rest (${change(2)}, #5)`,
      `    named as fixed on main by <sha> Fix part (${change(1)}, #5)`,
    ]);
    const parsed = JSON.parse(canon(root, bin, "issues", "--json").out) as Record<string, unknown>[];
    expect(parsed.map((i) => Object.keys(i).sort())).toEqual([["fixedBy", "number", "title", "url"], ["fixedBy", "number", "title", "url"]]);
    expect(parsed[0]).toEqual({ ...issue(7, "none yet"), fixedBy: [] });
    const fixes = parsed[1]!["fixedBy"] as { sha: string; subject: string }[];
    expect(fixes.map((c) => c.subject)).toEqual([`Fix rest (${change(2)}, #5)`, `Fix part (${change(1)}, #5)`]);
    expect(fixes.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
  });

  test("BR-2207: gh output that is not JSON, or JSON that is not a list, exits 4 and lists nothing; an empty list is fine", () => {
    const root = project();
    const html = canon(root, fakePath({ gh: true, raw: "<html>" }), "issues");
    expect([html.code, html.err.includes("not JSON"), html.err.includes("<html>"), html.out.includes("open issue(s)")]).toEqual([4, true, true, false]);
    const obj = canon(root, fakePath({ gh: true, raw: "{}" }), "issues");
    expect([obj.code, obj.err.includes("did not print a list"), obj.out.includes("open issue(s)")]).toEqual([4, true, false]);
    const empty = canon(root, fakePath({ gh: true, raw: "[]" }), "issues");
    expect([empty.code, empty.out.trim()]).toEqual([0, "0 open issue(s); 0 named as fixed by a commit on main"]);
  });
});

