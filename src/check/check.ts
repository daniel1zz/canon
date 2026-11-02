import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ID_PATTERN, stripCode, type Corpus, type Rule } from "../knowledge/model.ts";
import type { FileProblem } from "../knowledge/read.ts";
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
  | "template-unfilled"; // a rule, decision, change or domain README still holds a template placeholder line

export interface CheckInput {
  readonly root: string;
  readonly corpus: Corpus;
  readonly problems: readonly FileProblem[];
  /** Test files to scan for rule ids; defaults to every *.test.ts / *.spec.ts outside node_modules and canon/. */
  readonly testFiles?: readonly string[];
}

export function check(input: CheckInput): Finding[] {
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
    for (const ref of idsIn(stripCode(dom.body))) {
      if (!byId.has(ref)) findings.push({ path: dom.path, rule: "ref-dangling", message: `names ${ref}, which does not exist` });
    }
  }

  const rules = new Map<string, Rule>();
  for (const d of input.corpus.docs) if (d.kind === "rule") rules.set(d.id, d);
  const tested = new Set<string>();
  const testFiles = input.testFiles ?? findTestFiles(input.root);
  for (const file of testFiles) {
    const text = readFileSync(join(input.root, file), "utf8");
    for (const ref of idsIn(text)) {
      if (!ref.startsWith("BR-")) continue;
      const rule = rules.get(ref);
      if (!rule) findings.push({ path: file, rule: "ref-dangling", message: `test names ${ref}, which does not exist` });
      else if (rule.status === "retired") findings.push({ path: file, rule: "test-retired-rule", message: `test still names retired rule ${ref}` });
      else tested.add(ref);
    }
  }
  for (const rule of rules.values()) {
    if (rule.status === "active" && rule.untested === undefined && !tested.has(rule.id)) {
      findings.push({ path: rule.path, rule: "rule-untested", message: `${rule.id} has no test naming it and no \`untested:\` reason` });
    }
  }
  findings.push(...structureFindings(input.corpus));
  return findings;
}

/** Rule shape (BR-2033, BR-2034) and unfilled templates (BR-2035): outcomes of the document, checked at land. */
function structureFindings(corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const unfilled = hasPlaceholderLine;
  for (const d of corpus.docs) {
    if ((d.kind === "rule" || d.kind === "decision" || d.kind === "change") && unfilled(d.body)) {
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
    if (unfilled(dom.body)) out.push({ path: dom.path, rule: "template-unfilled", message: `domain ${dom.name} README still contains a template placeholder line` });
  }
  return out;
}

function idsIn(text: string): Set<string> {
  return new Set([...text.matchAll(ID_PATTERN)].map((m) => `${m[1]}-${m[2]}`));
}

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
