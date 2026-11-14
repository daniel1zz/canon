import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import { stripCode, type Corpus, type Doc } from "../documents/model.ts";
import { idsIn } from "../documents/types.ts";
import { DECISION_SECTION, proseIds } from "../links/links.ts";
import { inAChange } from "../domains/business.ts";
import { addedLines } from "./restatement/restatement.ts";
import { textAt } from "./restatement/work.ts";

/**
 * A decision's commitments reach the rules that hold them (BR-2469, D-112): every rule a decision's 决定 names in a
 * line this work wrote must be a current rule that names the decision back. A rule cited only as background belongs
 * in 背景. And a line this work wrote that defers behaviour to later work is pointed out (BR-2470).
 */
export interface CommitmentFinding {
  readonly path: string;
  readonly message: string;
}

/** The decision files this work added or changed: differences from its base, plus files not tracked yet. */
function workFiles(root: string, base: string, dir: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const call of [git(root, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, "--", dir), git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", dir)]) {
    if (!call.ok) continue;
    for (const line of call.value.split("\n")) if (line.trim() !== "") out.add(line.trim());
  }
  return out;
}

/** The 1-based line numbers of a `## ` section in a file's text, empty when the section is absent. */
function sectionLines(text: string, heading: string): Set<number> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  const out = new Set<number>();
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) out.add(i + 1);
  return out;
}

const isCurrent = (d: Doc) => (d.kind === "rule" && (d.status === "active" || d.status === "planned")) || (d.kind === "decision" && d.status !== "superseded");

export function commitmentFindings(root: string, corpus: Corpus, base: string | undefined): readonly CommitmentFinding[] {
  if (base === undefined) return [];
  // reason: the main checkout is not a change; there is no work to compare with (BR-2469, as BR-2431)
  if (!inAChange(root)) return [];
  const touched = workFiles(root, base, "canon/decisions");
  if (touched.size === 0) return [];
  const byId = new Map(corpus.docs.map((d) => [d.id, d]));
  const rulePrefix = `${corpus.types.find((t) => t.name === "rule")!.prefix}-`;
  const out: CommitmentFinding[] = [];
  for (const doc of corpus.docs) {
    if (doc.kind !== "decision" || !isCurrent(doc) || !touched.has(doc.path) || !existsSync(join(root, doc.path))) continue;
    const now = readFileSync(join(root, doc.path), "utf8");
    const lines = now.split("\n");
    const added = addedLines(now, textAt(root, base, doc.path));
    const named = new Set<string>();
    for (const n of sectionLines(now, DECISION_SECTION)) {
      if (!added.has(n)) continue;
      for (const id of idsIn(corpus.types, stripCode(lines[n - 1]!))) if (id.startsWith(rulePrefix)) named.add(id);
    }
    for (const id of [...named].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
      const rule = byId.get(id);
      // reason: an id that names nothing is ref-dangling's finding already
      if (rule === undefined || rule.kind !== "rule") continue;
      if (isCurrent(rule) && proseIds(corpus.types, rule.id, rule.body).has(doc.id)) continue;
      const why = isCurrent(rule) ? `${id} does not name ${doc.id}` : `${id} is ${rule.status}`;
      out.push({ path: doc.path, message: `${doc.id}'s 决定 names ${id} in a line this work wrote, but ${why}: each rule 决定 names must be an active or planned rule that names the decision back (a behaviour not built yet gets a rule with status: planned); a rule cited only as background belongs in 背景 (BR-2469)` });
    }
  }
  return out;
}

/** Words that put off a behaviour to later work (BR-2470). */
const DEFERRAL = /在那之前|由[^。；，\n]{0,30}?变更(?:来)?实现|后续变更|以后的变更|之后的变更|\blater change\b|\buntil then\b/i;

/** The lines of rules and decisions this work wrote that put off a behaviour to later work, as notes (BR-2470). */
export function deferralNotes(root: string, base: string, docs: readonly Doc[]): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    if ((doc.kind !== "rule" && doc.kind !== "decision") || !existsSync(join(root, doc.path))) continue;
    const now = readFileSync(join(root, doc.path), "utf8");
    const lines = now.split("\n");
    for (const n of [...addedLines(now, textAt(root, base, doc.path))].sort((a, b) => a - b)) {
      const line = stripCode(lines[n - 1]!);
      const m = DEFERRAL.exec(line);
      if (!m) continue;
      out.push(`note: ${doc.path}:${n} puts off a behaviour to later work (“${m[0]}”): give it a rule with status: planned that names the decision it comes from, so the commitment cannot be lost (BR-2470)`);
    }
  }
  return out;
}
