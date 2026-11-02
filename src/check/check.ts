import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ID_PATTERN, stripCode, type Corpus, type Rule } from "../knowledge/model.ts";
import type { FileProblem } from "../knowledge/read.ts";

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
  | "test-retired-rule"; // a test still names a retired rule

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
  return findings;
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
