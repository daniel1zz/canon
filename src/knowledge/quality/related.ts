import type { Workspace } from "../../work/workspace.ts";
import type { Corpus } from "../documents/model.ts";
import { coveredPaths, standings, standingText, touches, STATE_LABEL, type Standing } from "./verdicts.ts";

/**
 * The quality standards a piece of work is related to, and the lines that say so at a start, after a landing (BR-2592)
 * and in the release lines (BR-2593). Reminders only: nothing here refuses anything (D-139, D-145).
 */

/** How many standards a start or landing lists (BR-2592). */
export const RELATED_SHOWN = 10;

/** What the work touches: the domains of the rules a change lists, or the files a landing changed. */
export type Touched = { readonly domains: ReadonlySet<string> } | { readonly files: readonly string[] };

/** Whether a standard's covered range includes the work (BR-2592). */
function covers(corpus: Corpus, s: Standing, work: Touched): boolean {
  const spec = coveredPaths(corpus, s.q.covers);
  if (spec.all) return true;
  if ("files" in work) return work.files.some((f) => touches(spec, f));
  // reason: a standard covering a domain is related to a change with a rule in that domain or below it (BR-2592)
  return s.q.covers.some((c) => [...work.domains].some((d) => d === c || d.startsWith(`${c}/`)));
}

/** The standards in force related to the work, by number. */
export function relatedStandings(ws: Workspace, corpus: Corpus, work: Touched): { readonly ok: true; readonly standings: Standing[] } | { readonly ok: false; readonly message: string } {
  const all = standings(ws, corpus);
  if (!all.ok) return { ok: false, message: all.error.message };
  return { ok: true, standings: all.value.filter((s) => covers(corpus, s, work)) };
}

/** `quality: Q-1 [性能] 过期 …` lines, at most ten, then one for the rest (BR-2592). */
export function relatedLines(found: readonly Standing[], change: string | null): string[] {
  const out = found.slice(0, RELATED_SHOWN).map((s) => `quality: ${s.q.id} [${s.q.aspect}] ${standingText(s).replace(/^判定状态 /, "")}${change ? `；在 ${change} 变更文件的“陷阱和假设”里写这条标准怎么处理` : ""}`);
  if (found.length > RELATED_SHOWN) out.push(`quality: … 另有 ${found.length - RELATED_SHOWN} 条（canon quality status）`);
  return out;
}

/** The release line (BR-2593): the standards not proven, or undefined when every one is or none is in force. */
export function releaseLine(all: readonly Standing[]): string | undefined {
  const open = all.filter((s) => s.state !== "proven");
  if (open.length === 0) return undefined;
  return `质量标准没证明：${open.map((s) => `${s.q.id} ${STATE_LABEL[s.state]}`).join("，")}（写进发布问题，canon quality status）`;
}

/** The release line for a workspace, undefined when nothing is unproven; a failure to read is a line of its own. */
export function releaseLineOf(ws: Workspace, corpus: Corpus): string | undefined {
  const all = standings(ws, corpus);
  return all.ok ? releaseLine(all.value) : `质量标准没证明：读不出判定状态（${all.error.message}）`;
}
