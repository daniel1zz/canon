import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import type { Workspace } from "../workspace.ts";

/**
 * `canon issues` (BR-2168, BR-2169, BR-2170): the project's open GitHub issues, each with the commits on main
 * that name it as fixed, so a fixed issue left open is seen. Read only: canon never closes an issue itself.
 */

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

export interface FixCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface IssueStatus extends Issue {
  /** Commits on main naming this issue as fixed, newest first; empty when none does. */
  readonly fixedBy: readonly FixCommit[];
}

/** GitHub's closing keywords followed by an issue reference: "fixes #28", "Closes: #3". */
const KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#(\d+)\b/gi;
/** A parenthesised group, ASCII or full-width, as in "(C-117, #34)". */
const GROUP = /[(（]([^()（）]*)[)）]/g;

/**
 * Issue numbers a commit message names as fixed (BR-2169): after a closing keyword, or inside a parenthesised
 * group that also names a change ("(C-117, #34)"). The commit that opens a change only says which issue it is
 * about, so it names nothing as fixed.
 */
export function fixedIn(message: string, changePrefix: string): number[] {
  if (/^canon: open /.test(message)) return [];
  const out = new Set<number>();
  for (const m of message.matchAll(KEYWORD)) out.add(Number(m[1]));
  const change = new RegExp(`\\b${changePrefix}-\\d+\\b`);
  for (const g of message.matchAll(GROUP)) {
    if (!change.test(g[1]!)) continue;
    for (const n of g[1]!.matchAll(/#(\d+)\b/g)) out.add(Number(n[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Runs gh; a missing gh or a failed call is an environment error with a message that says what to do (BR-2170). */
function gh(cwd: string, ...args: string[]): Result<string> {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    return err("io", "gh (the GitHub CLI) is not installed or not on PATH; install it from https://cli.github.com and run gh auth login");
  }
  if (r.exitCode !== 0) return err("io", (r.stderr?.toString() || r.stdout?.toString() || "").trim());
  return ok(r.stdout?.toString() ?? "");
}

/** The open issues of the repository `gh` resolves from this checkout. */
export function openIssues(cwd: string): Result<Issue[]> {
  const list = gh(cwd, "issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,url");
  if (!list.ok) {
    if (list.error.message.startsWith("gh (the GitHub CLI)")) return list;
    const auth = gh(cwd, "auth", "status");
    if (!auth.ok && !auth.error.message.startsWith("gh (the GitHub CLI)")) return err("io", `gh is not authenticated: run gh auth login (${auth.error.message.split("\n")[0]})`);
    return err("io", `gh issue list failed: ${list.error.message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.value);
  } catch {
    return err("io", `gh issue list printed something that is not JSON: ${list.value.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) return err("io", "gh issue list did not print a list");
  return ok(parsed.map((i: { number: number; title: string; url: string }) => ({ number: i.number, title: i.title, url: i.url })).sort((a, b) => b.number - a.number));
}

/** Every commit on main with the issues it names as fixed. */
function fixCommits(ws: Workspace): Result<Map<number, FixCommit[]>> {
  const log = git(ws.primary, "log", ws.config.main, "--format=%H%x1f%s%x1f%b%x1e");
  if (!log.ok) return log;
  const prefix = ws.config.types.find((t) => t.name === "change")!.prefix;
  const out = new Map<number, FixCommit[]>();
  for (const rec of log.value.split("\x1e")) {
    const [sha, subject, body] = rec.trim().split("\x1f");
    if (!sha || subject === undefined) continue;
    for (const n of fixedIn(`${subject}\n${body ?? ""}`, prefix)) {
      const list = out.get(n) ?? [];
      list.push({ sha, subject });
      out.set(n, list);
    }
  }
  return ok(out);
}

export function issueStatus(ws: Workspace): Result<IssueStatus[]> {
  const issues = openIssues(ws.primary);
  if (!issues.ok) return issues;
  const fixes = fixCommits(ws);
  if (!fixes.ok) return fixes;
  return ok(issues.value.map((i) => ({ ...i, fixedBy: fixes.value.get(i.number) ?? [] })));
}

export function renderIssues(list: readonly IssueStatus[], main: string): string[] {
  const out: string[] = [];
  for (const i of list) {
    out.push(`#${i.number}  ${i.title}`);
    if (i.fixedBy.length === 0) out.push(`    open: no commit on ${main} names it as fixed`);
    else for (const c of i.fixedBy) out.push(`    named as fixed on ${main} by ${c.sha.slice(0, 9)} ${c.subject}`);
  }
  const fixed = list.filter((i) => i.fixedBy.length > 0);
  out.push(`${list.length} open issue(s); ${fixed.length} named as fixed by a commit on ${main}${fixed.length ? `: ${fixed.map((i) => `#${i.number}`).join(", ")}` : ""}`);
  if (fixed.length) out.push("canon does not close issues: check each fix against the issue, then gh issue close <n> --comment \"<commit>\"");
  return out;
}
