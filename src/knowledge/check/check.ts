import { fileSourceFailure, MIN_QUOTE, optionProblems, sourceFile, sources } from "./sources.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { technicalLayerWord, technicalNameAdvice } from "../documents/domain-names.ts";
import { stripCode, type Corpus, type Rule } from "../documents/model.ts";
import type { FileProblem } from "../documents/read.ts";
import { idsIn as idsOf } from "../documents/types.ts";
import { BACKLOG_FILE, readBacklog } from "../documents/backlog.ts";
import { caseNames, REPORT_RECIPES } from "../../work/verify/report.ts";
import type { TestReports } from "../../work/verify/ledger.ts";
import { historyOf, pathFindings } from "./paths.ts";
import { listFindings } from "./lists.ts";
import { architectureFindings, type ArchitectureBase, type ArchitectureRule } from "./architecture.ts";
import { releaseFindings } from "../releases/check.ts";
import { planFindings } from "../plans/check.ts";
import { EXAMPLE_SECTION, hasPlaceholderLine, isPlaceholderLine, RULE_SECTION, section } from "../documents/templates.ts";

/**
 * `canon check`: the corpus-integrity half of the landing boundary (design §3). It checks outcomes only:
 * the corpus parses, every id is unique, every reference resolves, and rules and tests point at each other.
 * It never checks how an agent worked.
 */
export interface Finding {
  readonly path: string;
  readonly rule: CheckRule;
  readonly message: string;
}

export type CheckRule =
  | "file-invalid" // a canon/ file does not fit the model
  | "id-duplicate" // two files claim one id
  | "ref-dangling" // a document or test names an id that does not exist
  | "amends-not-decision" // a decision's `amends` names a document that is not a decision, or itself (BR-2139)
  | "supersedes-not-decision" // a decision's `supersedes` names a document that is not a decision, or itself (BR-2230)
  | "instructions-missing" // a file `instructions` lists in canon/config.yaml does not exist (BR-2231)
  | "rule-untested" // an active rule has no test and no `untested:` reason (a planned one needs none, BR-2235)
  | "test-report-missing" // a test file this change touches has no report for its current content (BR-2344)
  | "test-report-stale" // test files changed since their last report: only ever a note (BR-2345)
  | "test-retired-rule" // a test still names a retired rule
  | "rule-no-statement" // an active or planned rule has no non-empty "## 规则" section
  | "rule-no-example" // an active or planned rule without `untested:` has no example in "## 例子"
  | "example-before-change" // a current rule's "## 例子" states how the product behaved before the change (BR-2301)
  | "domain-code-missing" // a domain README lists a code path that does not exist (BR-2079)
  | "domain-name-technical" // a domain named after a technical layer: only ever a note, never a finding (BR-2318)
  | "domain-code-declared" // a README lists `code:` where the layout gives the location (BR-2117)
  | "code-layout" // with code_root: a domain without its directory, or a directory no domain or shared entry owns (BR-2118)
  | "decision-options" // a decision's options section shows no real choice (BR-2109)
  | "source-malformed" // a source line in a decision's options does not name a target and quote it (BR-2110)
  | "source-quote-missing" // a current decision's source names a repository file that no longer holds its quote (BR-2252)
  | "doc-missing-section" // a document lacks a section its type requires, or the section is empty (BR-2091)
  | "path-missing" // a current document names, in backticks, a repository path that was moved or deleted
  | "list-mismatch" // a rule's `lists` front matter disagrees with its text or with the code (BR-2180)
  | "release-frozen" // a shipped release's 目标, 范围, 不做 or its set of tagged rules differs from what it was at `shipped_at` (D-61)
  | ArchitectureRule // the architecture overview and the domains and decisions it must follow (D-65)
  | "template-unfilled"; // a rule, decision, change, declared-type document or domain README still holds a template placeholder line

export interface CheckInput {
  readonly root: string;
  readonly corpus: Corpus;
  readonly problems: readonly FileProblem[];
  /** The test files `tests` finds (BR-2046): the files whose reports name rules (BR-2005). */
  readonly testFiles: readonly string[];
  /** What the ledger holds for those test files (BR-2005); without it no test file has a report. */
  readonly reports?: TestReports;
  /** Ids whose change file is on their own change branch, not yet on main: the backlog may list them (BR-2150, D-50). */
  readonly branchChanges?: ReadonlySet<string>;
  /**
   * Ids main's committed backlog already lists. A dangling id among them is a note (`backlogNotes`), not a finding:
   * its branch went after it was listed, and that must not block main or landings that did not list it (BR-2150, #112).
   */
  readonly backlogBase?: ReadonlySet<string>;
  /** What was there before this work, for the architecture checks (D-65); without it every domain and link counts as new. */
  readonly architecture?: ArchitectureBase;
}

/** Backlog ids that name no change in the tree and no change only on its own branch, each marked when main already lists it. */
function backlogDangling(input: CheckInput): { finding: Finding; known: boolean }[] {
  const out: { finding: Finding; known: boolean }[] = [];
  for (const e of readBacklog(input.root, input.corpus.types)) {
    const target = input.corpus.docs.find((x) => x.id === e.id);
    // reason: the owner orders work still only on its branch too; it lands later with its file (BR-2150, D-50)
    if (!target && input.branchChanges?.has(e.id)) continue;
    if (target?.kind === "change") continue;
    const known = input.backlogBase?.has(e.id) ?? false;
    const message = known
      ? `lists ${e.id}, which is not a change on main or on a local change branch; remove the line, or restore its branch`
      : `lists ${e.id}, which is not a change`;
    out.push({ finding: { path: `${BACKLOG_FILE}:${e.line}`, rule: "ref-dangling", message }, known });
  }
  return out;
}

/** The dangling backlog ids main already lists: said, never blocking (BR-2150, D-50). */
export function backlogNotes(input: CheckInput): Finding[] {
  return backlogDangling(input).filter((d) => d.known).map((d) => d.finding);
}

const FIRST = 5;
/** The first few names, and how many more there are. */
const listed = (files: readonly string[]): string => `${files.slice(0, FIRST).join(", ")}${files.length > FIRST ? `, and ${files.length - FIRST} more` : ""}`;

/**
 * Test files whose newest report is for older content and that this change does not make relevant: their rows still
 * count, said once, never blocking (BR-2345).
 */
export function staleReportNotes(input: CheckInput): Finding[] {
  const reports = input.reports;
  if (!reports) return [];
  const stale = input.testFiles.filter((f) => {
    const row = reports.files.get(f);
    return row !== undefined && !row.fresh && !reports.relevant.has(f);
  });
  if (stale.length === 0) return [];
  return [{
    path: stale[0]!,
    rule: "test-report-stale",
    message: `${stale.length} test file(s) changed since their last report (${listed(stale)}); the rules their older report names still count as tested. Run canon work test ${stale.slice(0, 5).join(" ")}${stale.length > 5 ? " …" : ""} to refresh`,
  }];
}

/** How a backlog note is printed: one line naming the place and the fix (BR-2150). */
export const noteLine = (f: Finding): string => `note: ${f.path}: ${f.message}`;

/** Domains named after a technical layer: said, never blocking (BR-2318). */
export function domainNameNotes(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  for (const dom of input.corpus.domains) {
    const word = technicalLayerWord(dom.name);
    if (word !== undefined) out.push({ path: dom.path, rule: "domain-name-technical", message: technicalNameAdvice(dom.name, word) });
  }
  return out;
}

export function check(input: CheckInput): Finding[] {
  const idsIn = (text: string) => idsOf(input.corpus.types, text);
  const findings: Finding[] = input.problems.map((p) => ({ path: p.path, rule: "file-invalid", message: p.message }));
  const byId = new Map<string, string[]>();
  for (const d of input.corpus.docs) byId.set(d.id, [...(byId.get(d.id) ?? []), d.path]);
  for (const [id, paths] of byId) {
    if (paths.length > 1) for (const p of paths) findings.push({ path: p, rule: "id-duplicate", message: `${id} is also used by ${paths.filter((x) => x !== p).join(", ")}` });
  }

  for (const d of input.corpus.docs) {
    // Ids written as code (`BR-12` or inside a fenced block) are examples, not references.
    for (const ref of idsIn(stripCode(d.body) + (d.kind === "change" ? ` ${d.rules.join(" ")} ${Object.keys(d.passes).join(" ")}` : "") + (d.kind === "decision" ? ` ${d.supersedes.join(" ")}` : "") + (d.kind === "decision" ? ` ${d.amends.join(" ")}` : ""))) {
      if (ref !== d.id && !byId.has(ref)) findings.push({ path: d.path, rule: "ref-dangling", message: `names ${ref}, which does not exist` });
    }
    if (d.kind === "decision") {
      for (const a of d.amends) {
        const target = input.corpus.docs.find((x) => x.id === a);
        if (a === d.id) findings.push({ path: d.path, rule: "amends-not-decision", message: `amends itself; list the decisions it changes in part (BR-2139)` });
        else if (target && target.kind !== "decision") findings.push({ path: d.path, rule: "amends-not-decision", message: `amends ${a}, which is a ${target.kind}, not a decision (BR-2139)` });
      }
      // reason: a wrong target is otherwise found only when the decision is accepted (BR-2230, BR-2027)
      for (const s of d.supersedes) {
        const target = input.corpus.docs.find((x) => x.id === s);
        if (s === d.id) findings.push({ path: d.path, rule: "supersedes-not-decision", message: `supersedes itself; name the decision it replaces (BR-2230)` });
        else if (target && target.kind !== "decision") findings.push({ path: d.path, rule: "supersedes-not-decision", message: `supersedes ${s}, which is a ${target.kind}, not a decision (BR-2230)` });
      }
    }
  }
  // The owner's order names changes only; a typo would silently drop a change from where the owner put it (BR-2150).
  for (const d of backlogDangling(input)) if (!d.known) findings.push(d.finding);
  const { codeRoot } = input.corpus.layout;
  for (const dom of input.corpus.domains) {
    if (dom.declared.length > 0 && (codeRoot !== undefined || dom.parent)) {
      const why = codeRoot !== undefined ? `its code is ${codeRoot}/${dom.name} by convention (code_root)` : "a subdomain is business only; its code is found through the top-level domain";
      findings.push({ path: dom.path, rule: "domain-code-declared", message: `remove \`code:\` from the README: ${why}` });
    }
    // A path that does not exist silently drops the domain from `canon context <path>` (BR-2079).
    if (codeRoot === undefined) {
      for (const c of dom.code) {
        if (!existsSync(join(input.root, c))) findings.push({ path: dom.path, rule: "domain-code-missing", message: `code path ${c} does not exist; fix it or remove it from the README` });
      }
    }
    for (const ref of idsIn(stripCode(dom.body))) {
      if (!byId.has(ref)) findings.push({ path: dom.path, rule: "ref-dangling", message: `names ${ref}, which does not exist` });
    }
  }

  const rules = new Map<string, Rule>();
  for (const d of input.corpus.docs) if (d.kind === "rule") rules.set(d.id, d);
  const tested = new Set<string>();
  const testFiles = input.testFiles;
  const rulePrefix = `${input.corpus.types.find((t) => t.name === "rule")!.prefix}-`;
  const reports = input.reports;
  const noReport: string[] = [];
  const emptyReport: string[] = [];
  for (const file of testFiles) {
    // reason: what tests a file holds, and whether they run, is what its test framework reported (BR-2005, D-64);
    // an older row stands in only for a file this change does not make relevant, which has its own finding (BR-2344)
    const row = reports?.files.get(file);
    if (!row || (!row.fresh && reports!.relevant.has(file))) {
      noReport.push(file);
      continue;
    }
    if (row.cases.length === 0) emptyReport.push(file);
    for (const c of row.cases) {
      for (const ref of idsIn(caseNames(c))) {
        if (!ref.startsWith(rulePrefix)) continue;
        const rule = rules.get(ref);
        if (!rule) findings.push({ path: file, rule: "ref-dangling", message: `test names ${ref}, which does not exist` });
        else if (rule.status === "retired") findings.push({ path: file, rule: "test-retired-rule", message: `test still names retired rule ${ref}` });
        else if (c.runs) tested.add(ref);
      }
    }
  }
  // reason: one finding for the project, with the files and the command that fixes it (BR-2344)
  const missing = testFiles.filter((f) => reports?.relevant.has(f) && !reports.files.get(f)?.fresh);
  if (missing.length > 0) {
    findings.push({
      path: missing[0]!,
      rule: "test-report-missing",
      message: `${missing.length} test file(s) this change touches have no report for their current content (${listed(missing)}): ${
        reports?.noTestCommand ? `canon/config.yaml sets no test_command, so nothing records reports; ${REPORT_RECIPES}` : `run canon work test ${missing.slice(0, 5).join(" ")}${missing.length > 5 ? " …" : ""}`
      }`,
    });
  }
  // reason: a planned rule is designed but not executed yet, so it needs no test (BR-2235, BR-2005)
  for (const rule of rules.values()) {
    if (rule.status === "active" && rule.untested === undefined && !tested.has(rule.id)) {
      const why = [
        ...(noReport.length > 0 ? [`${noReport.length} test file(s) have no report: run canon work test --all`] : []),
        ...(emptyReport.length > 0 ? [`reports with no testcase: ${listed(emptyReport)}`] : []),
      ];
      findings.push({ path: rule.path, rule: "rule-untested", message: `${rule.id} has no running test whose title names it and no \`untested:\` reason${why.length ? ` (${why.join("; ")})` : ""}` });
    }
  }
  findings.push(...structureFindings(input.root, input.corpus));
  findings.push(...instructionFindings(input.root));
  if (codeRoot !== undefined) findings.push(...layoutFindings(input.root, input.corpus));
  for (const f of pathFindings(input.root, input.corpus)) findings.push({ path: f.path, rule: "path-missing", message: f.message });
  findings.push(...releaseFindings(input.root, input.corpus));
  findings.push(...planFindings(input.corpus));
  for (const f of listFindings(input.root, input.corpus)) findings.push({ path: f.path, rule: "list-mismatch", message: f.message });
  findings.push(...architectureFindings(input));
  return findings;
}

/**
 * BR-2118: with a code root, every domain has its directory and every directory is a domain's, a shared
 * entry or an ancestor of one; a file directly under the code root or in such an ancestor is reported too, and
 * so is a shared path that overlaps a domain's directory. Inside a domain without subdomains the layout is the domain's own business,
 * so only the levels where domains branch are checked. A directory holding only tests or fixtures gets no
 * exemption: tests sit next to their code, and an exemption would let any stray directory pass.
 */
function layoutFindings(root: string, corpus: Corpus): Finding[] {
  const { codeRoot, shared } = corpus.layout;
  if (codeRoot === undefined) return [];
  const out: Finding[] = [];
  for (const dom of corpus.domains) {
    const dir = `${codeRoot}/${dom.name}`;
    if (!isDir(join(root, dir))) out.push({ path: dom.path, rule: "code-layout", message: `domain ${dom.name} has no code directory ${dir}` });
  }
  for (const s of shared) {
    if (!existsSync(join(root, s))) out.push({ path: "canon/config.yaml", rule: "code-layout", message: `shared path ${s} does not exist` });
    // reason: shared code is no domain's; a shared path in or around a domain's directory would give one path two owners (BR-2118)
    for (const dom of corpus.domains) {
      const dir = `${codeRoot}/${dom.name}`;
      if (s === dir || s.startsWith(`${dir}/`) || dir.startsWith(`${s}/`)) out.push({ path: "canon/config.yaml", rule: "code-layout", message: `shared path ${s} overlaps the directory ${dir} of domain ${dom.name}` });
    }
  }
  const names = new Set(corpus.domains.map((d) => d.name));
  const branches = (name: string) => corpus.domains.some((d) => d.parent === name);
  // `owned`: rel is a domain's directory, so a file directly in it is that domain's.
  const walk = (rel: string, domain: string | undefined, owned: boolean): void => {
    const full = join(root, codeRoot, rel);
    if (!isDir(full)) return;
    for (const child of readdirSync(full).sort()) {
      if (child.startsWith(".")) continue;
      const name = rel === "" ? child : `${rel}/${child}`;
      const path = `${codeRoot}/${name}`;
      if (shared.some((s) => path === s || path.startsWith(`${s}/`))) continue;
      // reason: a file inside a domain's directory is that domain's; one directly under the code root, or in an
      // ancestor of a shared path, is nobody's (BR-2118)
      if (!isDir(join(full, child))) {
        if (!owned) out.push({ path, rule: "code-layout", message: `${path} belongs to no domain; move it into a domain's directory or list it under shared` });
        continue;
      }
      if (names.has(name)) {
        if (branches(name)) walk(name, name, true);
      } else if (shared.some((s) => s.startsWith(`${path}/`))) walk(name, domain, false);
      else {
        const where = domain ? `domain ${domain} has no subdomain ${name}` : `no domain ${name}`;
        out.push({ path, rule: "code-layout", message: `${path} belongs to no domain (${where}); create the domain, move the code, or list the directory under shared` });
      }
    }
  };
  walk("", undefined, false);
  return out;
}

function isDir(full: string): boolean {
  return existsSync(full) && statSync(full).isDirectory();
}

function isFile(full: string): boolean {
  return existsSync(full) && statSync(full).isFile();
}

/**
 * BR-2231: every file `instructions` lists must exist. Only a list written in canon/config.yaml counts: the default
 * `[CLAUDE.md]` is no claim that the file exists, since `canon init` creates none. So the raw file is read here, not
 * the config with its defaults filled in; a config that does not parse is already refused by every command (BR-2045).
 */
function instructionFindings(root: string): Finding[] {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return [];
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const listed = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)["instructions"] : undefined;
  if (!Array.isArray(listed)) return [];
  return listed
    .filter((p): p is string => typeof p === "string" && !isFile(join(root, p)))
    .map((p) => ({ path: CONFIG_FILE, rule: "instructions-missing", message: `instructions lists ${p}, which is not a file in the repository (BR-2231)` }));
}

const CONFIG_FILE = "canon/config.yaml";

const TERMS_SECTION = "术语";

/** Required sections (BR-2091), rule shape (BR-2033, BR-2034) and unfilled templates (BR-2035): outcomes of the document, checked at land. */
function structureFindings(root: string, corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const unfilled = hasPlaceholderLine;
  const filled = (body: string, title: string) => {
    const text = section(body, `## ${title}`);
    return text !== undefined && text.split("\n").some((l) => l.trim() !== "" && !isPlaceholderLine(l));
  };
  for (const d of corpus.docs) {
    const required = corpus.types.find((t) => t.name === (d.kind === "extra" ? d.type : d.kind))?.sections ?? [];
    const missing = required.filter((s) => !filled(d.body, s));
    if (missing.length) {
      out.push({ path: d.path, rule: "doc-missing-section", message: `${d.id} lacks or leaves empty: ${missing.map((s) => `## ${s}`).join(", ")}` });
    }
    if (d.kind !== "note" && unfilled(d.body)) {
      out.push({ path: d.path, rule: "template-unfilled", message: `${d.id} still contains a template placeholder line` });
    }
    if (d.kind === "decision") {
      for (const p of optionProblems(d.body)) out.push({ path: d.path, rule: "decision-options", message: `${d.id} ${p.message}` });
      const found = sources(d.body);
      for (const line of found.malformed) out.push({ path: d.path, rule: "source-malformed", message: `${d.id}: ${line} (want 来源：<URL or repository path> “<quote of at least ${MIN_QUOTE} characters>”)` });
      // reason: a path that is no file (a word such as arXiv taken as a path) is found here, not only at landing (BR-2110, BR-2111);
      // a file git history had was moved or deleted after the decision quoted it, so it is not reported (BR-2110, D-25)
      // reason: one lstat-first look per source decides both checks, so a link is never followed, not even to ask
      // whether its target exists (BR-2186, BR-2252)
      const files = found.sources.filter((src) => !/^https?:\/\//.test(src.target)).map((src) => ({ src, failure: fileSourceFailure(root, src) }));
      const gone = files.filter((f) => f.failure?.kind === "no-file").map((f) => ({ line: f.src.line, file: sourceFile(f.src) }));
      // reason: a superseded decision is history, its sources quote files as they were (BR-2252, BR-2171); a file
      // that is gone now is BR-2110's to judge, so only a file that exists is checked for its quote
      if (d.status !== "superseded") {
        for (const { src, failure } of files) {
          if (failure?.kind === "no-quote" || failure?.kind === "link") out.push({ path: d.path, rule: "source-quote-missing", message: `${d.id}: ${failure.message} (${src.line})` });
        }
      }
      if (gone.length > 0) {
        const history = historyOf(root, [...new Set(gone.map((g) => g.file))], "source paths");
        for (const g of gone) {
          if (history.ok && history.files.includes(g.file)) continue;
          const why = history.ok ? "" : `; ${history.message}`;
          out.push({ path: d.path, rule: "source-malformed", message: `${d.id}: ${g.line} (${g.file} is not a file in the repository${why})` });
        }
      }
    }
    // reason: a planned rule is held to the same shape as an active one: its executing change verifies this text (BR-2033, BR-2034)
    if (d.kind !== "rule" || d.status === "retired") continue;
    const statement = section(d.body, RULE_SECTION);
    if (statement === undefined || statement.trim() === "") {
      out.push({ path: d.path, rule: "rule-no-statement", message: `${d.id} has no "${RULE_SECTION}" section with the statement` });
    }
    const before = beforeChangeWording(section(d.body, EXAMPLE_SECTION) ?? "");
    if (before !== undefined) {
      out.push({ path: d.path, rule: "example-before-change", message: `${d.id}: "${EXAMPLE_SECTION}" says how it was before the change ("${before}"); examples state only what the product must do now, the old behaviour belongs in the change file's 为什么` });
    }
    if (d.untested !== undefined) continue;
    const examples = (section(d.body, EXAMPLE_SECTION) ?? "").split("\n").filter((l) => l.trim() !== "" && !isPlaceholderLine(l));
    if (examples.length === 0) out.push({ path: d.path, rule: "rule-no-example", message: `${d.id} has no example under "${EXAMPLE_SECTION}"` });
  }
  for (const dom of corpus.domains) {
    if (!filled(dom.body, TERMS_SECTION)) out.push({ path: dom.path, rule: "doc-missing-section", message: `domain ${dom.name} README lacks or leaves empty: ## ${TERMS_SECTION}` });
    if (unfilled(dom.body)) out.push({ path: dom.path, rule: "template-unfilled", message: `domain ${dom.name} README still contains a template placeholder line` });
  }
  return out;
}

/**
 * Wording that describes the product before a change (BR-2301). Every example line the rule review had removed from
 * canon/rules used 改动前; the rest are its plain synonyms. "改动之前" and "原来是" are left out: "在做任何改动之前" states an
 * order and "原来是" an input's earlier state, both current behaviour.
 */
const BEFORE_CHANGE = ["改动前", "修改前", "修复前", "原来会", "以前会", "before this change", "before the fix", "previously"];

/** The first before-the-change wording in an examples section, outside code spans and fences; undefined when there is none. */
export function beforeChangeWording(examples: string): string | undefined {
  // reason: text in backticks is the product's input or output, which may hold these words (BR-2301)
  const text = stripCode(examples).toLowerCase();
  return BEFORE_CHANGE.find((w) => text.includes(w));
}
