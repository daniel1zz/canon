import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../kernel/git.ts";
import type { Corpus, Decision } from "../../documents/model.ts";
import { inAChange } from "../../domains/business.ts";

/**
 * The design basis of a one-way-door change (D-124): a change that touches persisted data, an outside boundary or a
 * dependency says in its change file what it reuses, what it newly chooses, its worst failure, its evidence and what
 * would prove it wrong. canon only finds the touched classes from paths and says so; how good the basis is, the rule
 * review judges (BR-2493). Nothing here refuses a landing except a revising decision with no reason (BR-2492).
 */

/** The one-way-door classes, in the order they are reported (BR-2491). */
export const DESIGN_CLASSES = ["persistent", "boundary", "dependency"] as const;
export type DesignClass = (typeof DESIGN_CLASSES)[number];

/** The question each class must answer: the uncertainty that, when left open, cost rework in the calibration (D-124). */
export const CLASS_QUESTION: Readonly<Record<DesignClass, string>> = {
  persistent: "how the persisted data evolves (an old file with a new section, a migration) and how it recovers (corrupt, recovered, then written again): show the smallest failing case was tried",
  boundary: "what the outside thing's own configuration and limits are (its official docs or source), and where the docs leave it open, one smallest probe in the real topology",
  dependency: "why this dependency over building it or another one, and its limits where it will actually run",
};

/** Paths of each class when `design_signals` sets none: package manifests and lock files, migration directories (BR-2491). */
export const DEFAULT_DESIGN_SIGNALS: Readonly<Record<DesignClass, readonly string[]>> = {
  persistent: ["**/migrations/**"],
  boundary: [],
  dependency: ["**/package.json", "**/bun.lock", "**/bun.lockb", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/requirements*.txt", "**/pyproject.toml", "**/Cargo.toml", "**/go.mod", "**/Gemfile"],
};

/** The section of a change file that holds the basis (BR-2491). */
export const BASIS_HEADING = "## 方案依据";

/** Why a decision revises another, as its `revised_because` front matter says (BR-2492). */
export const REVISION_REASONS = ["premise", "requirement", "external", "experience", "implementation"] as const;

/** The classes a set of changed paths touches, each with the paths that touched it; canon's own documents never count. */
export function touchedClasses(paths: readonly string[], signals: Readonly<Record<DesignClass, readonly string[]>>): Map<DesignClass, string[]> {
  const out = new Map<DesignClass, string[]>();
  for (const cls of DESIGN_CLASSES) {
    const globs = signals[cls].map((g) => new Bun.Glob(g));
    const hit = paths.filter((p) => !p.startsWith("canon/") && globs.some((g) => g.match(p)));
    if (hit.length > 0) out.set(cls, hit);
  }
  return out;
}

/** The files this work changed since `base`, plus files not tracked yet. */
export function workPaths(root: string, base: string): string[] {
  const out = new Set<string>();
  for (const call of [git(root, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base), git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard")]) {
    if (!call.ok) continue;
    for (const line of call.value.split("\n")) if (line.trim() !== "") out.add(line.trim());
  }
  return [...out].sort();
}

/** True when the text has a 方案依据 section with something besides the template's placeholder lines. */
export function hasBasis(text: string): boolean {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === BASIS_HEADING);
  if (at < 0) return false;
  for (const l of lines.slice(at + 1)) {
    if (/^## /.test(l)) break;
    const t = l.trim();
    if (t !== "" && !/^<[^>]*>$/.test(t)) return true;
  }
  return false;
}

/** The change id this checkout works on, from its branch `change/C-n-...`; undefined for a chore or the primary checkout. */
export function workChange(root: string): string | undefined {
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch.ok) return undefined;
  const m = /^change\/([A-Za-z]+-\d+)(?:-|$)/.exec(branch.value.trim());
  return m?.[1];
}

/** The one line a note or the review gets for each touched class: the class, a few of its paths, its question. */
export function classLines(touched: ReadonlyMap<DesignClass, readonly string[]>): string[] {
  return [...touched].map(([cls, paths]) => `${cls} (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, and ${paths.length - 3} more` : ""}): ${CLASS_QUESTION[cls]}`);
}

/**
 * BR-2491: the note `canon check` gives when this work touches a one-way-door class and its change file has no
 * 方案依据; never a finding. A chore that touches one is told the basis belongs in a change.
 */
export function designBasisNote(root: string, corpus: Corpus, base: string | undefined, signals: Readonly<Record<DesignClass, readonly string[]>>): string | undefined {
  // reason: the main checkout is not a piece of work; there is nothing to compare with (as BR-2469)
  if (base === undefined || !inAChange(root)) return undefined;
  const touched = touchedClasses(workPaths(root, base), signals);
  if (touched.size === 0) return undefined;
  const id = workChange(root);
  const doc = id === undefined ? undefined : corpus.docs.find((d) => d.id === id && d.kind === "change");
  if (doc && hasBasis(readFileSync(join(root, doc.path), "utf8"))) return undefined;
  const where = doc ? `add a ${BASIS_HEADING} section to ${doc.path}` : `a chore has no change file: if this is a new choice, make it in a change with a ${BASIS_HEADING} section`;
  return [
    `note: this work touches one-way-door paths (BR-2491, D-124); ${where}: what it reuses (a decision and which part of it), what it newly chooses, its worst failure, its evidence, and what result would prove it wrong. Evidence by what is uncertain: reuse with unchanged premises needs only the decision; otherwise answer, with a source or a smallest experiment:`,
    ...classLines(touched).map((l) => `  - ${l}`),
  ].join("\n");
}

/**
 * BR-2492: a decision this work adds that amends or supersedes another must say why in `revised_because`, one of
 * REVISION_REASONS, so canon stats can tell a wrong first choice from new needs (D-124). Decisions already on main are not checked.
 */
export function revisionReasonFindings(root: string, corpus: Corpus, base: string | undefined): { path: string; message: string }[] {
  if (base === undefined) return [];
  const added = new Set<string>();
  for (const call of [git(root, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=A", "--no-renames", base, "--", "canon/decisions"), git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", "canon/decisions")]) {
    if (call.ok) for (const l of call.value.split("\n")) if (l.trim() !== "") added.add(l.trim());
  }
  const out: { path: string; message: string }[] = [];
  for (const d of corpus.docs) {
    if (d.kind !== "decision" || !added.has(d.path)) continue;
    const revised = [...d.amends, ...d.supersedes];
    if (revised.length === 0) continue;
    const why = (d as Decision).revisedBecause;
    if (why !== undefined && (REVISION_REASONS as readonly string[]).includes(why)) continue;
    out.push({
      path: d.path,
      message: `${d.id} revises ${revised.join(", ")} but ${why === undefined ? "names no" : `names an unknown`} \`revised_because\`${why === undefined ? "" : ` (${why})`}: write one of ${REVISION_REASONS.join(", ")} in its front matter: premise (the first choice was wrong under its own premises), requirement (a new need), external (an outside thing changed), experience (the owner's experience feedback), implementation (a bug, not the design) (BR-2492)`,
    });
  }
  return out;
}
