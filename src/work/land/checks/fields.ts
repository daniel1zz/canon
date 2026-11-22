import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../kernel/git.ts";
import { readCorpus } from "../../../knowledge/documents/read.ts";
import { parseDocFile } from "../../../knowledge/documents/docfile.ts";
import { allowedText, dueFields, revisesDecision } from "../../../knowledge/documents/stated.ts";
import { parse } from "yaml";
import { readTypes } from "../../../knowledge/documents/config-keys.ts";

/**
 * BR-2624 (D-159): every document this landing adds (absent on main, added on the branch) must have the fields its
 * type, as main declares it, wants stated at creation. Documents already on main are not checked; a chore's change file
 * is written by its landing, so it is never on the branch. Returns one line per missing field, or why it cannot tell.
 */
export function missingStatedFields(wt: string, main: string, layout: Parameters<typeof readCorpus>[2]): { lines: string[] } | { error: string } {
  const added = git(wt, "diff", "--name-only", "--diff-filter=A", "--no-renames", main, "HEAD", "--", "canon");
  if (!added.ok) return { error: `cannot list the documents this branch adds: ${added.error.message}` };
  const paths = new Set(added.value.split("\n").filter((p) => p.endsWith(".md")));
  if (paths.size === 0) return { lines: [] };
  // reason: main's declarations decide, so a field main declared after this branch started is stated before it lands (BR-2624);
  // only `types` is read, since the rest of main's config names files of main's tree, not of this worktree
  const text = git(wt, "show", `${main}:canon/config.yaml`);
  let raw: unknown;
  try {
    raw = text.ok ? parse(text.value) : undefined;
  } catch (e) {
    return { error: `${main}'s canon/config.yaml is not valid YAML: ${(e as Error).message}` };
  }
  const types = readTypes(raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["types"] : undefined);
  if (!types.ok) return { error: `${main}'s canon/config.yaml: ${types.error.message}` };
  const corpus = readCorpus(wt, types.value, layout).corpus;
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

/** The refusal for the lines `missingStatedFields` gave (BR-2624). */
export const statedFieldsMessage = (lines: readonly string[]): string =>
  `${lines.length} field(s) to state on the documents this landing adds (BR-2624); set each in this worktree, commit, and land again:\n${lines.map((l) => `  ${l}`).join("\n")}`;
