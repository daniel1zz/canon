import { git } from "../../kernel/git.ts";
import type { Corpus } from "../../knowledge/documents/model.ts";

/** A proposed decision older than this is listed by the brief (BR-2476). */
export const PROPOSED_AGE_HOURS = 24;
const SHOWN = 10;

/**
 * The brief's lines about decisions on main still `proposed` for more than PROPOSED_AGE_HOURS since their file reached
 * main (BR-2476, #217): oldest first, up to 10 by id and title, then how many more. Nothing when there are none.
 */
export function proposedNotice(primary: string, main: string, corpus: Corpus, now: number = Date.now()): string[] {
  const proposed = corpus.docs.filter((d) => d.kind === "decision" && d.status === "proposed");
  if (proposed.length === 0) return [];
  // reason: one git log gives every decision file's first commit on main, not one call per decision (BR-2476)
  const log = git(primary, "-c", "core.quotePath=false", "log", "--diff-filter=A", "--format=@%ct", "--name-only", main, "--", "canon/decisions");
  if (!log.ok) return [`Cannot tell how long proposed decisions have waited: ${log.error.message}`];
  const since = new Map<string, number>();
  let at = 0;
  for (const line of log.value.split("\n")) {
    if (line.startsWith("@")) at = Number(line.slice(1)) * 1000;
    else if (line.trim() !== "") since.set(line.trim(), at); // log is newest first, so the oldest add wins
  }
  const old = proposed
    .map((d) => ({ d, t: since.get(d.path) }))
    .filter((x): x is { d: (typeof proposed)[number]; t: number } => x.t !== undefined && now - x.t > PROPOSED_AGE_HOURS * 3_600_000)
    .sort((a, b) => a.t - b.t || a.d.id.localeCompare(b.d.id, "en", { numeric: true }));
  if (old.length === 0) return [];
  const days = (t: number) => Math.floor((now - t) / 86_400_000);
  return [
    `${old.length} decision(s) proposed for more than ${PROPOSED_AGE_HOURS} h: accept each one in effect with canon decision accept <D-n> in a change; ask the owner (canon human ask) only about one still waiting on their choice`,
    ...old.slice(0, SHOWN).map((x) => `  ${x.d.id} ${x.d.title} (${days(x.t)} d)`),
    ...(old.length > SHOWN ? [`  … and ${old.length - SHOWN} more (canon decision list)`] : []),
  ];
}
