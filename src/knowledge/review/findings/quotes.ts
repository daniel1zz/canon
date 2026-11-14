/**
 * What a review finding's text names and quotes (BR-2433), kept apart from the findings store so the review's answer parser
 * can use it without importing the store, which imports the review's criteria.
 */
const ID = /(?<![A-Za-z0-9-])(BR|D|R)-(\d+)(?![0-9])/g;
const QUOTE = /「([^」]*)」|“([^”]*)”|`([^`\n]*)`/g;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The rule, decision and release ids `text` names, anywhere in it, unique and sorted (BR-2433). */
export function namedIds(text: string): string[] {
  return [...new Set([...text.matchAll(ID)].map((m) => `${m[1]}-${m[2]}`))].sort();
}

/**
 * The quoted words a finding points at (BR-2433): every span in 「」, “” or single backticks, whitespace squashed,
 * without the spans that are empty or hold only ids (`BR-1` names a document, it quotes nothing); unique and sorted.
 */
export function quotedSpans(text: string): string[] {
  const spans = [...text.matchAll(QUOTE)].map((m) => squash(m[1] ?? m[2] ?? m[3] ?? ""));
  return [...new Set(spans.filter((s) => s.replace(ID, "").replace(/[\s,，、]/g, "") !== ""))].sort();
}
