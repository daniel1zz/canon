import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordDb } from "../db.ts";
import type { Layout } from "../../knowledge/documents/model.ts";
import { git } from "../../kernel/git.ts";
import { CHECKS, LAND_CHECKS, LAND_STAGES } from "./checks.ts";

/**
 * Check precision from the event table (C-9, P6). Counting refusals alone makes a check that refuses a lot
 * look useful; what tells a good refusal from a bad one is what happened next (BR-2068):
 *   changed    the same change later landed with different code: the refusal caught something
 *   same       it later landed with the same code: probably a false refusal
 *   abandoned  the change was dropped without landing
 *   pending    nothing yet
 *   unknown    the refusal has no change, or predates fingerprints
 */
export type Outcome = "changed" | "same" | "abandoned" | "pending" | "unknown";

export interface CheckStats {
  readonly check: string;
  /** Times the check ran (BR-2067); for landing checks, landings that reached it. */
  readonly runs: number;
  readonly refused: number;
  /** Outcomes of the refusals; only landing checks have them. */
  readonly outcomes: Readonly<Record<Outcome, number>> | null;
  /** Configured review date, if any (BR-2069). */
  readonly review: string | null;
  readonly due: boolean;
  /** `check` refusals broken down by finding kind (BR-2095); null for every other check. */
  readonly kinds: readonly KindStats[] | null;
}

export interface KindStats {
  /** A finding kind of `canon check`, or `unrecorded` for refusals recorded before kinds were (BR-2094). */
  readonly kind: string;
  /** Refusals that had at least one finding of this kind. */
  readonly refused: number;
  /** Findings of this kind across those refusals. */
  readonly findings: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
}

interface Row {
  readonly id: number;
  readonly kind: string;
  readonly subject: string | null;
  readonly detail: Record<string, unknown>;
}

export function computeStats(db: CoordDb, reviews: Readonly<Record<string, string>>, today: string): CheckStats[] {
  const rows: Row[] = db.db
    .query<{ id: number; kind: string; subject: string | null; detail: string }, []>(
      "SELECT id, kind, subject, detail FROM events WHERE kind IN ('land.refuse','land.ok','claim.take','claim.renew','claim.refuse','start.ok','start.refuse','drop.done','change.status') ORDER BY id",
    )
    .all()
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const refusalsOf = (check: string) => rows.filter((r) => r.kind === "land.refuse" && r.detail["reason"] === check);
  const landed = count((r) => r.kind === "land.ok");

  const outcomeOf = (r: Row): Outcome => {
    if (!r.subject) return "unknown";
    const later = rows.filter((x) => x.id > r.id && x.subject === r.subject);
    const ok = later.find((x) => x.kind === "land.ok");
    if (ok) {
      const before = r.detail["diff"];
      const after = ok.detail["diff"];
      if (typeof before !== "string" || typeof after !== "string") return "unknown";
      return before === after ? "same" : "changed";
    }
    if (later.some((x) => x.kind === "drop.done" || (x.kind === "change.status" && x.detail["status"] === "dropped"))) return "abandoned";
    return "pending";
  };

  const zero = (): Record<Outcome, number> => ({ changed: 0, same: 0, abandoned: 0, pending: 0, unknown: 0 });
  const kindsOf = (refusals: readonly Row[]): KindStats[] => {
    const by = new Map<string, { refused: number; findings: number; outcomes: Record<Outcome, number> }>();
    for (const r of refusals) {
      const recorded = r.detail["findings"];
      const counts: Record<string, number> = recorded && typeof recorded === "object" ? (recorded as Record<string, number>) : { unrecorded: 0 };
      const outcome = outcomeOf(r);
      for (const [kind, n] of Object.entries(counts)) {
        const k = by.get(kind) ?? { refused: 0, findings: 0, outcomes: zero() };
        k.refused++;
        k.findings += n;
        k.outcomes[outcome]++;
        by.set(kind, k);
      }
    }
    return [...by].map(([kind, k]) => ({ kind, ...k })).sort((a, b) => b.refused - a.refused || a.kind.localeCompare(b.kind));
  };

  const out: CheckStats[] = [];
  for (const check of CHECKS) {
    let runs: number;
    let refused: number;
    let outcomes: Record<Outcome, number> | null = null;
    if (LAND_CHECKS.includes(check)) {
      const stage = LAND_STAGES.findIndex((s) => s.includes(check));
      const reachedLater = LAND_STAGES.slice(stage).flat().reduce((n, c) => n + refusalsOf(c).length, 0);
      runs = reachedLater + landed;
      const mine = refusalsOf(check);
      refused = mine.length;
      outcomes = zero();
      for (const r of mine) outcomes[outcomeOf(r)]++;
    } else if (check === "claim") {
      refused = count((r) => r.kind === "claim.refuse");
      runs = refused + count((r) => r.kind === "claim.take" || r.kind === "claim.renew");
    } else {
      refused = count((r) => r.kind === "start.refuse" && r.detail["reason"] === "setup");
      runs = refused + count((r) => r.kind === "start.ok" && r.detail["setup"] === true);
    }
    const review = reviews[check] ?? null;
    const kinds = check === "check" ? kindsOf(refusalsOf(check)) : null;
    out.push({ check, runs, refused, outcomes, review, due: review !== null && review <= today, kinds });
  }
  return out;
}

export function renderStats(stats: readonly CheckStats[]): string {
  const lines = [`${"check".padEnd(11)} ${"runs".padStart(5)} ${"refused".padStart(8)} ${"changed".padStart(8)} ${"same".padStart(5)} ${"abandoned".padStart(10)} ${"pending".padStart(8)} ${"unknown".padStart(8)}  review`];
  const n = (v: number | undefined, w: number) => (v === undefined ? "-" : String(v)).padStart(w);
  for (const s of stats) {
    const o = s.outcomes ?? undefined;
    lines.push(
      `${s.check.padEnd(11)} ${n(s.runs, 5)} ${n(s.refused, 8)} ${n(o?.changed, 8)} ${n(o?.same, 5)} ${n(o?.abandoned, 10)} ${n(o?.pending, 8)} ${n(o?.unknown, 8)}  ${s.review ?? "(no date)"}`,
    );
  }
  const kinds = stats.find((s) => s.check === "check")?.kinds ?? [];
  if (kinds.length > 0) {
    const w = Math.max(18, ...kinds.map((k) => k.kind.length));
    lines.push("", "check refusals by finding kind:");
    lines.push(`  ${"kind".padEnd(w)} ${"refused".padStart(8)} ${"findings".padStart(9)} ${"changed".padStart(8)} ${"same".padStart(5)} ${"abandoned".padStart(10)} ${"pending".padStart(8)} ${"unknown".padStart(8)}`);
    for (const k of kinds) {
      const o = k.outcomes;
      lines.push(`  ${k.kind.padEnd(w)} ${n(k.refused, 8)} ${n(k.findings, 9)} ${n(o.changed, 8)} ${n(o.same, 5)} ${n(o.abandoned, 10)} ${n(o.pending, 8)} ${n(o.unknown, 8)}`);
    }
  }
  const due = stats.filter((s) => s.due);
  if (due.length > 0) {
    lines.push("", "Due for review:");
    for (const s of due) {
      const o = s.outcomes;
      lines.push(`  ${s.check} (since ${s.review}): ${s.runs} runs, ${s.refused} refused${o ? `, ${o.changed} caught a change, ${o.same} landed unchanged (possibly false)` : ""}`);
    }
  }
  const undated = stats.filter((s) => s.review === null);
  if (undated.length > 0) lines.push("", `No review date (set check_reviews in canon/config.yaml): ${undated.map((s) => s.check).join(", ")}`);
  return lines.join("\n");
}

/** Above this share of the code root's lines, shared code is reported as too large (BR-2121). */
export const SHARED_LIMIT_PERCENT = 20;

export interface SharedShare {
  readonly codeRoot: string;
  readonly sharedLines: number;
  readonly totalLines: number;
}

/**
 * Lines of tracked files under the `shared` entries against all tracked lines under the code root (BR-2121).
 * Shared code is what no domain's rules describe, so its share is how much code sits outside every
 * domain; undefined when the project sets no code root or no shared entry.
 */
export function sharedShare(root: string, layout: Layout): SharedShare | undefined {
  if (layout.codeRoot === undefined || layout.shared.length === 0) return undefined;
  const files = git(root, "-c", "core.quotePath=false", "ls-files", "--", layout.codeRoot);
  if (!files.ok) return undefined;
  let sharedLines = 0;
  let totalLines = 0;
  for (const f of files.value.split("\n").filter(Boolean)) {
    const full = join(root, f);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, "utf8");
    const n = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    totalLines += n;
    if (layout.shared.some((s) => f === s || f.startsWith(`${s}/`))) sharedLines += n;
  }
  return { codeRoot: layout.codeRoot, sharedLines, totalLines };
}

export function renderSharedShare(s: SharedShare): string {
  const pct = s.totalLines === 0 ? 0 : (100 * s.sharedLines) / s.totalLines;
  const line = `shared code: ${s.sharedLines} of ${s.totalLines} lines under ${s.codeRoot} (${pct.toFixed(1)}%)`;
  return pct > SHARED_LIMIT_PERCENT ? `${line}: above ${SHARED_LIMIT_PERCENT}%; move code that serves one domain into that domain's directory` : line;
}
