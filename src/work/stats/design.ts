import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../db.ts";
import type { Corpus } from "../../knowledge/documents/model.ts";
import { DESIGN_CLASSES, REVISION_REASONS, type DesignClass } from "../../knowledge/check/design-basis/design-basis.ts";

/**
 * BR-2494: how often one-way-door landings wrote a design basis, and why decisions were revised, so the owner can see
 * which class keeps missing its basis or keeps being revised as wrong under its own premises before any of them is made a
 * hard gate (D-124).
 */
export interface DesignStats {
  /** Per class: landings in the window that touched it, and how many of those had a design basis. */
  readonly classes: Readonly<Record<DesignClass, { readonly landings: number; readonly withBasis: number }>>;
  /** Per `revised_because`: decisions on main that revise another, and how many came within 7 days of the one they revise. */
  readonly revisions: readonly { readonly reason: string; readonly count: number; readonly within7Days: number }[];
}

const DAY = 86_400;

/**
 * When each decision id first appeared in the history of `ref`, seconds since the epoch, from the decision files' names.
 * reason: not `git log --follow`: it follows copies too, so a decision written from a copy of another would take that
 * one's date; with renames off, a renamed file is a new add of the same id, and the earliest add is the first (BR-2494)
 */
function firstAdded(root: string, ref: string, dirs: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (dirs.length === 0) return out;
  const r = git(root, "-c", "core.quotePath=false", "log", "--no-renames", "--diff-filter=A", "--format=%x00%ct", "--name-only", ref, "--", ...dirs);
  if (!r.ok) return out;
  for (const commit of r.value.split("\0").slice(1)) {
    const [time, ...files] = commit.split("\n").filter((l) => l.trim() !== "");
    const at = Number(time);
    for (const f of files) {
      const id = /^([A-Za-z]+-\d+)(?=[-.])/.exec(f.slice(f.lastIndexOf("/") + 1))?.[1];
      if (id !== undefined && (out.get(id) ?? Infinity) > at) out.set(id, at);
    }
  }
  return out;
}

/**
 * `corpus` and `ref` are main as committed (the caller reads the corpus at `ref`): a decision only proposed on a work
 * branch or left uncommitted is not a revision that happened (BR-2494).
 */
export function designStats(db: CoordDb, root: string, corpus: Corpus, ref: string, since: number, until: number): DesignStats {
  const classes = Object.fromEntries(DESIGN_CLASSES.map((c) => [c, { landings: 0, withBasis: 0 }])) as Record<DesignClass, { landings: number; withBasis: number }>;
  const rows = db.db.query<{ detail: string }, [number, number]>("SELECT detail FROM events WHERE id > ? AND id <= ? AND kind = 'design.basis'").all(since, until);
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { basis?: boolean; classes?: Record<string, unknown> };
    for (const c of Object.keys(d.classes ?? {})) {
      if (!(c in classes)) continue;
      classes[c as DesignClass].landings++;
      if (d.basis === true) classes[c as DesignClass].withBasis++;
    }
  }
  const byId = new Map(corpus.docs.map((d) => [d.id, d]));
  const decisions = corpus.docs.filter((d) => d.kind === "decision");
  const added = firstAdded(root, ref, [...new Set(decisions.map((d) => d.path.slice(0, d.path.lastIndexOf("/"))))]);
  const tally = new Map<string, { count: number; within7Days: number }>();
  for (const d of corpus.docs) {
    if (d.kind !== "decision" || d.revisedBecause === undefined) continue;
    const revised = [...d.amends, ...d.supersedes].map((id) => byId.get(id)).filter((x) => x !== undefined);
    if (revised.length === 0) continue;
    const t = tally.get(d.revisedBecause) ?? { count: 0, within7Days: 0 };
    t.count++;
    const at = added.get(d.id);
    // reason: "soon" is measured from the revised decision's first commit under its id; a decision git cannot date, or dated before the one it revises (a clock set back), is not counted as soon; one revising several counts once if it is soon after any of them (BR-2494)
    if (at !== undefined && revised.some((r) => { const was = added.get(r.id); return was !== undefined && at - was >= 0 && at - was <= 7 * DAY; })) t.within7Days++;
    tally.set(d.revisedBecause, t);
  }
  const order = [...REVISION_REASONS, ...[...tally.keys()].filter((k) => !(REVISION_REASONS as readonly string[]).includes(k)).sort()];
  return { classes, revisions: order.filter((r) => tally.has(r)).map((reason) => ({ reason, ...tally.get(reason)! })) };
}

/** The lines `canon stats` prints; undefined when no landing touched a class and no decision gave a revision reason. */
export function renderDesignStats(s: DesignStats): string | undefined {
  const touched = DESIGN_CLASSES.filter((c) => s.classes[c].landings > 0);
  if (touched.length === 0 && s.revisions.length === 0) return undefined;
  const lines = ["design basis (BR-2494):"];
  for (const c of touched) lines.push(`  ${c}: ${s.classes[c].landings} landing(s), ${s.classes[c].withBasis} with a basis`);
  if (s.revisions.length > 0) lines.push(`  decisions revised, by revised_because: ${s.revisions.map((r) => `${r.reason} ${r.count} (${r.within7Days} within 7 days)`).join(", ")}`);
  return lines.join("\n");
}
