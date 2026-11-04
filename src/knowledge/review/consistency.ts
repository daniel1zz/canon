import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../../config/config.ts";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { testFilesFor } from "../check/tests.ts";
import { testTitles } from "../check/test-titles.ts";
import type { Domain, Rule } from "../documents/model.ts";
import { readCorpus } from "../documents/read.ts";
import { fileFindings, openIssues, parseFindings, run, type Env, type Finding, type Filing, type OpenIssue } from "./code-review.ts";

/**
 * Post-land consistency check (C-54, D-43): for the domains a landing touched, an independent reviewer reads the
 * rules, the tests that name them and the domain's code, and says whether the tests cover both sides of each
 * example and whether the code does what the rules say (BR-2271). Findings are filed like the code review's, under
 * their own label so the precision of each review can be told apart (BR-2272); the closed issues' reasons are that
 * precision, and below the stop line the check stops calling the reviewer (BR-2273).
 */
export const CONSISTENCY_LABEL = "canon-consistency";
export const CONSISTENCY: Filing = { label: CONSISTENCY_LABEL, who: "post-land consistency check" };
const KINDS = ["untested-side", "code-mismatch"] as const;
const MAX_FILE_BYTES = 100_000;

export interface Limits {
  readonly maxDomains: number;
  readonly maxBytes: number;
  readonly minClosed: number;
  readonly minPrecision: number;
}

export const DEFAULT_LIMITS: Limits = { maxDomains: 1, maxBytes: 150_000, minClosed: 10, minPrecision: 0.5 };

export interface Precision {
  readonly completed: number;
  readonly closed: number;
  readonly open: number;
}

/** Closed issues of the label by close reason, and how many are open (BR-2273). */
export function precision(e: Env): Result<Precision> {
  const closed = run(e.gh, ["issue", "list", "--state", "closed", "--label", CONSISTENCY_LABEL, "--limit", "1000", "--json", "number,stateReason"], e.cwd);
  if (!closed.ok) return closed;
  const open = openIssues(e, CONSISTENCY_LABEL);
  if (!open.ok) return open;
  const list = JSON.parse(closed.value || "[]") as { stateReason?: string }[];
  return ok({ completed: list.filter((i) => (i.stateReason ?? "").toUpperCase() === "COMPLETED").length, closed: list.length, open: open.value.length });
}

/** The domain whose code covers a path most specifically (the longest covering code directory wins). */
function owner(domains: readonly Domain[], path: string): Domain | undefined {
  let best: { d: Domain; n: number } | undefined;
  for (const d of domains) for (const c of d.code) if ((path === c || path.startsWith(`${c}/`)) && (!best || c.length > best.n)) best = { d, n: c.length };
  return best?.d;
}

/** The domain a changed path belongs to: canon/rules/<domain>/… by its directory, other files by their code directory. */
function domainOf(domains: readonly Domain[], path: string): Domain | undefined {
  const m = /^canon\/rules\/(.+)\/[^/]+$/.exec(path);
  if (m) return domains.find((d) => d.name === m[1]);
  return owner(domains, path);
}

interface Material {
  readonly rules: readonly Rule[];
  readonly prompt: string;
  readonly tests: number;
  readonly code: number;
}

function material(tree: string, files: readonly string[], domain: Domain, rules: readonly Rule[], domains: readonly Domain[], testFiles: readonly string[], open: readonly OpenIssue[]): Material {
  const ids = new Set(rules.map((r) => r.id));
  const named = (title: string) => (title.match(/\b[A-Z]+-\d+\b/g) ?? []).some((id) => ids.has(id));
  const tests: string[] = [];
  for (const file of testFiles) {
    if (!lstatSync(join(tree, file), { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileSync(join(tree, file), "utf8");
    const lines = text.split("\n");
    for (const t of testTitles(text)) if (t.runs && named(t.title)) tests.push(`## ${file}:${t.start}\n\n${lines.slice(t.start - 1, t.end).join("\n")}`);
  }
  const testSet = new Set(testFiles);
  const code: string[] = [];
  for (const path of files.filter((p) => p !== "" && !testSet.has(p) && owner(domains, p) === domain).sort()) {
    const full = join(tree, path);
    // reason: a symbolic link in the tree is not followed, so nothing outside the landed commit is sent to the reviewer
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\u0000")) continue;
    code.push(`## ${path}\n\n${text}`);
  }
  const prompt = [
    `You check one business domain of a project, \`${domain.name}\`, for consistency between its rules, its tests and its code. The rules say how the product must behave; each rule's "## 例子" lists examples on both sides of a boundary.`,
    "Answer only two questions. (1) untested-side: is there an example side (one input and its result) that no test below asserts? (2) code-mismatch: does the code do something other than what a rule says (another exit code, message, condition or order)? Ignore style, naming, performance and anything else.",
    "Report a problem only when you can name the rule id, the exact file and line (for untested-side: the test file and line where the missing case belongs, or the rule file), and the concrete input and the wrong or missing result. Before reporting, try once to disprove it by reading the code and the tests again. Report only what survives.",
    "Several symptoms of one root cause are ONE finding. If an open issue below already describes the same root cause, set `existing` to its number.",
    'Answer with JSON only: {"findings":[{"kind":"untested-side"|"code-mismatch","title":"<short>","root_cause":"<one sentence>","rule":"<rule id>","file":"<path>","line":<n>,"scenario":"<input → result the rule requires, and what the code or tests do>","existing":<issue number or null>}]}',
    "",
    "# Rules",
    ...rules.map((r) => `\n## ${r.path}\n\n${readFileSync(join(tree, r.path), "utf8")}`),
    "",
    "# Tests whose titles name these rules",
    ...(tests.length ? tests.map((t) => `\n${t}`) : ["(none)"]),
    "",
    "# Code of the domain",
    ...(code.length ? code.map((c) => `\n${c}`) : ["(none)"]),
    "",
    "# Open issues already filed by this check",
    open.length ? open.map((i) => `- #${i.number} ${i.title}\n  ${i.body.split("\n").slice(0, 6).join("\n  ")}`).join("\n") : "(none)",
  ].join("\n");
  return { rules, prompt, tests: tests.length, code: code.length };
}

/** Keeps findings that name a rule of the domain, with the rule id in front of the scenario (BR-2272). */
function namingRule(text: string, ids: ReadonlySet<string>, say: (line: string) => void): Result<Finding[]> {
  const parsed = parseFindings(text, say, KINDS);
  if (!parsed.ok) return parsed;
  const out: Finding[] = [];
  for (const f of parsed.value) {
    if (f.rule === undefined || !ids.has(f.rule)) {
      say(`dropped a finding that names no rule of this domain: ${JSON.stringify(f).slice(0, 200)}`);
      continue;
    }
    out.push({ ...f, scenario: `${f.rule}: ${f.scenario}` });
  }
  return ok(out);
}

export function consistencyReview(e: Env, limits: Limits): Result<void> {
  const p = precision(e);
  if (!p.ok) return p;
  // reason: the stop line of D-43: enough closed issues, and fewer than the minimum share of them were real (BR-2273)
  if (p.value.closed >= limits.minClosed && p.value.completed / p.value.closed < limits.minPrecision) {
    e.say(`off: precision ${p.value.completed}/${p.value.closed} is below ${limits.minPrecision}; remove it from hooks.after_land`);
    return ok(undefined);
  }
  const changed = git(e.cwd, "diff", "--name-only", e.base, e.head);
  if (!changed.ok) return changed;
  const tree = mkdtempSync(join(tmpdir(), "canon-consistency-"));
  try {
    // reason: main may have moved past CANON_HEAD, so everything is read from that commit's tree, as the code review does (BR-2070)
    const archive = Bun.spawnSync(["sh", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", e.cwd, e.head, tree], { stdout: "pipe", stderr: "pipe" });
    if (archive.exitCode !== 0) return err("io", `git archive ${e.head} exited ${archive.exitCode}: ${archive.stderr.toString().trim().slice(0, 300)}`);
    const listed = git(e.cwd, "ls-tree", "-r", "--name-only", e.head);
    if (!listed.ok) return listed;
    const config = readConfig(tree);
    if (!config.ok) return config;
    const { corpus } = readCorpus(tree, config.value.types, config.value);
    const counts = new Map<string, number>();
    for (const path of changed.value.split("\n").filter(Boolean)) {
      const d = domainOf(corpus.domains, path);
      if (d) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    }
    if (counts.size === 0) {
      e.say("no domain's rules or code changed; nothing to check");
      return ok(undefined);
    }
    const order = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
    const chosen = order.slice(0, limits.maxDomains);
    if (order.length > chosen.length) e.say(`not checked (--max-domains ${limits.maxDomains}): ${order.slice(chosen.length).join(", ")}`);
    const testFiles = testFilesFor(tree, config.value);
    const open = openIssues(e, CONSISTENCY_LABEL);
    if (!open.ok) return open;
    for (const name of chosen) {
      const domain = corpus.domains.find((d) => d.name === name)!;
      const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.domain === name && d.status !== "retired");
      if (rules.length === 0) {
        e.say(`${name}: no rules; skipped`);
        continue;
      }
      const m = material(tree, listed.value.split("\n"), domain, rules, corpus.domains, testFiles, open.value);
      const bytes = Buffer.byteLength(m.prompt, "utf8");
      if (bytes > limits.maxBytes) {
        e.say(`${name}: ${bytes} bytes is over --max-bytes ${limits.maxBytes}; not checked`);
        continue;
      }
      e.say(`checking ${name}: ${rules.length} rules, ${m.tests} tests, ${m.code} code files, ${bytes} bytes`);
      const answer = run(e.ai, [], e.cwd, m.prompt);
      if (!answer.ok) return answer;
      const findings = namingRule(answer.value, new Set(rules.map((r) => r.id)), e.say);
      if (!findings.ok) return findings;
      const domainSay = (line: string) => e.say(line === "no findings" ? `${name}: no findings` : line);
      const filed = fileFindings({ ...e, say: domainSay }, findings.value, open.value, CONSISTENCY);
      if (!filed.ok) return filed;
    }
    return ok(undefined);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}
