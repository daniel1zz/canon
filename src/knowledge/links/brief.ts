import type { Corpus } from "../documents/model.ts";
import { linksOf } from "./start.ts";
import { confirmHint } from "./links.ts";

/**
 * BR-2429: what `canon brief` says about suspect references. In a change's worktree (`names`: the ids the change names)
 * each suspect reference touching one of them; elsewhere the count. A starting commit that cannot be read is said, never fatal.
 */
export function suspectNotice(root: string, corpus: Corpus, since: string | undefined, names?: ReadonlySet<string>): string[] {
  const links = linksOf(root, corpus, since);
  if (!links.ok) return [`canon links: ${links.error.message}`];
  const suspect = links.value.filter((l) => l.suspect);
  if (names === undefined) return suspect.length ? [`${suspect.length} suspect reference(s): canon links list`] : [];
  return suspect.filter((l) => names.has(l.from) || names.has(l.to)).map((l) => `Suspect reference: ${l.from} -> ${l.to} (${confirmHint(l)})`);
}
