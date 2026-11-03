import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripCode, type Corpus, type Rule } from "../knowledge/model.ts";
import type { FileProblem } from "../knowledge/read.ts";
import { idsIn as idsOf } from "../knowledge/types.ts";
import { testTitles } from "./test-titles.ts";
import { EXAMPLE_SECTION, hasPlaceholderLine, isPlaceholderLine, RULE_SECTION, section } from "../knowledge/templates.ts";

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
  | "rule-untested" // an active rule has no test and no `untested:` reason
  | "test-retired-rule" // a test still names a retired rule
  | "rule-no-statement" // an active rule has no non-empty "## 规则" section
  | "rule-no-example" // an active rule with tests has no example in "## 例子"
  | "domain-code-missing" // a domain README lists a code path that does not exist (BR-2079)
  | "doc-missing-section" // a document lacks a section its type requires, or the section is empty (BR-2091)
  | "template-unfilled"; // a rule, decision, change, declared-type document or domain README still holds a template placeholder line

export interface CheckInput {
  readonly root: string;
  readonly corpus: Corpus;
  readonly problems: readonly FileProblem[];
  /** Test files to scan for rule ids; defaults to every *.test.ts / *.spec.ts outside node_modules and canon/. */
  readonly testFiles?: readonly string[];
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
    for (const ref of idsIn(stripCode(d.body) + (d.kind === "change" ? ` ${d.rules.join(" ")}` : "") + (d.kind === "decision" && d.supersedes ? ` ${d.supersedes}` : ""))) {
      if (ref !== d.id && !byId.has(ref)) findings.push({ path: d.path, rule: "ref-dangling", message: `names ${ref}, which does not exist` });
    }
  }
  for (const dom of input.corpus.domains) {
    // A path that does not exist silently drops the domain from `canon context <path>` (BR-2079).
    for (const c of dom.code) {
      if (!existsSync(join(input.root, c))) findings.push({ path: dom.path, rule: "domain-code-missing", message: `code path ${c} does not exist; fix it or remove it from the README` });
    }
    for (const ref of idsIn(stripCode(dom.body))) {
      if (!byId.has(ref)) findings.push({ path: dom.path, rule: "ref-dangling", message: `names ${ref}, which does not exist` });
    }
  }

  const rules = new Map<string, Rule>();
  for (const d of input.corpus.docs) if (d.kind === "rule") rules.set(d.id, d);
  const tested = new Set<string>();
  const testFiles = input.testFiles ?? findTestFiles(input.root);
  const rulePrefix = `${input.corpus.types.find((t) => t.name === "rule")!.prefix}-`;
  for (const file of testFiles) {
    const text = readFileSync(join(input.root, file), "utf8");
    // reason: in JS/TS files only test titles name rules, and only titles that run make a rule tested (BR-2005,
    // D-12); other languages have no title parser, so their whole text still counts.
    const titles = JS_TS.test(file) ? testTitles(text) : [{ title: text, runs: true }];
    for (const { title, runs } of titles) {
      for (const ref of idsIn(title)) {
        if (!ref.startsWith(rulePrefix)) continue;
        const rule = rules.get(ref);
        if (!rule) findings.push({ path: file, rule: "ref-dangling", message: `test names ${ref}, which does not exist` });
        else if (rule.status === "retired") findings.push({ path: file, rule: "test-retired-rule", message: `test still names retired rule ${ref}` });
        else if (runs) tested.add(ref);
      }
    }
  }
  for (const rule of rules.values()) {
    if (rule.status === "active" && rule.untested === undefined && !tested.has(rule.id)) {
      findings.push({ path: rule.path, rule: "rule-untested", message: `${rule.id} has no running test whose title names it and no \`untested:\` reason` });
    }
  }
  findings.push(...structureFindings(input.corpus));
  return findings;
}

const TERMS_SECTION = "术语";

/** Required sections (BR-2091), rule shape (BR-2033, BR-2034) and unfilled templates (BR-2035): outcomes of the document, checked at land. */
function structureFindings(corpus: Corpus): Finding[] {
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
    if (d.kind !== "rule" || d.status !== "active") continue;
    const statement = section(d.body, RULE_SECTION);
    if (statement === undefined || statement.trim() === "") {
      out.push({ path: d.path, rule: "rule-no-statement", message: `${d.id} has no "${RULE_SECTION}" section with the statement` });
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

const JS_TS = /\.[cm]?[jt]sx?$/;

const SKIP_DIRS = new Set(["node_modules", ".git", "canon", "dist", ".cache"]);

export function findTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}
