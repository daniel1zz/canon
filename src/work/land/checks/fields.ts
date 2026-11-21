import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../kernel/git.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { parseDocFile } from "../../../knowledge/documents/docfile.ts";
import { allowedText, dueFields, revisesDecision } from "../../../knowledge/documents/stated.ts";
import { configFromHistory } from "../../workspace.ts";

/**
 * BR-2624 (D-159): every document this landing adds (absent on main, added on the branch) must have the fields its
 * type, as main declares it, wants stated at creation. Documents already on main are not checked; a chore's change file
 * is written by its landing, so it is never on the branch. Returns one line per missing field, or why it cannot tell.
 */
export function missingStatedFields(wt: string, main: string): { lines: string[] } | { error: string } {
  const added = git(wt, "diff", "--name-only", "--diff-filter=A", "--no-renames", main, "HEAD", "--", "canon");
  if (!added.ok) return { error: `cannot list the documents this branch adds: ${added.error.message}` };
  const paths = new Set(added.value.split("\n").filter((p) => p.endsWith(".md")));
  if (paths.size === 0) return { lines: [] };
  // reason: main's declarations decide, so a field main declared after this branch started is stated before it lands (BR-2624)
  const config = configFromHistory(wt, main);
  if (!config.ok) return { error: `cannot read ${main}'s canon/config.yaml: ${config.error.message}` };
  const corpus = readCorpus(wt, config.value.types, config.value).corpus;
  const lines: string[] = [];
  for (const doc of corpus.docs) {
    if (!paths.has(doc.path)) continue;
    const typeName = doc.kind === "extra" ? doc.type : doc.kind;
    const type = corpus.types.find((t) => t.name === typeName);
    if (!type) continue;
    const parsed = parseDocFile(readFileSync(join(wt, doc.path), "utf8"), doc.path);
    if (!parsed.ok) continue; // reason: an unreadable file is canon check's finding (file-invalid), not this check's
    const meta = parsed.value.meta;
    const ctx = { corpus, ...(doc.kind === "rule" ? { domain: doc.domain } : {}) };
    const revising = type.name === "decision" && revisesDecision(corpus, meta["amends"], meta["supersedes"], doc.id);
    for (const f of dueFields(type, revising)) {
      if (meta[f.name] !== undefined) continue;
      lines.push(`${doc.id} (${doc.path}) has no ${f.name}: canon doc set ${doc.id} ${f.name} "<value>", the value ${allowedText(type, f, ctx)}`);
    }
  }
  return { lines };
}
