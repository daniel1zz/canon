import type { CoordDb } from "../db.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Verdicts on rule-review findings (D-49, superseding D-35). A review block carries several findings, so each
 * finding is judged on its own. Verdicts are recorded by hand (`canon verdict record`) as `human`, self-reported:
 * canon cannot tell a person from an agent run outside Claude Code (BR-2023). A `model` verdict can only come from
 * an event written by something else; it counts the same for what is still pending, but is reported on its own.
 */
export type Verdict = "real" | "spurious" | "unclear";
export type Judge = "model" | "human";
export const VERDICTS: readonly Verdict[] = ["real", "spurious", "unclear"];
/** Below this many real plus spurious verdicts of one judge no share is reported (BR-2255, D-49). */
export const MIN_VERDICTS = 10;

interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly detail: Record<string, unknown>;
}

const COLS = "id, ts, actor, kind, subject, detail";

function rows(db: CoordDb, sql: string, ...params: (string | number)[]): EventRow[] {
  return db.db
    .query<{ id: number; ts: string; actor: string; kind: string; subject: string | null; detail: string }, (string | number)[]>(sql)
    .all(...params)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

const findingsOf = (b: EventRow): string[] => (Array.isArray(b.detail["findings"]) ? (b.detail["findings"] as unknown[]).map(String) : []);

const reviewBlocks = (db: CoordDb, since: number, until: number) => rows(db, `SELECT ${COLS} FROM events WHERE kind = 'review.block' AND id > ? AND id <= ? ORDER BY id`, since, until);

const verdictsUpTo = (db: CoordDb, until: number) => rows(db, `SELECT ${COLS} FROM events WHERE kind = 'review.verdict' AND id <= ? ORDER BY id`, until);

export interface FindingState {
  readonly n: number;
  readonly text: string;
  readonly model: Verdict | null;
  readonly human: Verdict | null;
}

/** A review block of a change that landed afterwards, recorded with the commit the review saw (BR-2253). */
export interface JudgeableBlock {
  readonly block: number;
  /** The land.refuse this block caused. */
  readonly refusal: number;
  readonly subject: string;
  readonly ts: string;
  /** The commit the reviewer saw when it blocked, as the block event recorded it. */
  readonly before: string;
  readonly findings: readonly FindingState[];
}

/** One review block as judgeable, or null when it has no findings, subject or commit, no refusal or never landed (BR-2253). */
function judgeable(db: CoordDb, b: EventRow, verdicts: readonly EventRow[]): JudgeableBlock | null {
  const texts = findingsOf(b);
  const before = b.detail["commit"];
  // reason: blocks written before the event recorded the commit cannot show the code the review saw, so they are not judgeable (BR-2253, D-49)
  if (!b.subject || texts.length === 0 || typeof before !== "string") return null;
  // reason: the landing writes review.block and then returns the refusal, so the block's refusal is the next review refusal of the change (D-49)
  const refusal = rows(db, `SELECT ${COLS} FROM events WHERE kind = 'land.refuse' AND subject = ? AND id > ? ORDER BY id`, b.subject, b.id).find((r) => r.detail["reason"] === "review");
  if (!refusal) return null;
  if (rows(db, `SELECT ${COLS} FROM events WHERE kind = 'land.ok' AND subject = ? AND id > ? ORDER BY id LIMIT 1`, b.subject, refusal.id).length === 0) return null;
  const verdictOf = (n: number, judge: Judge) => (verdicts.find((v) => v.detail["block"] === b.id && v.detail["finding"] === n && v.detail["judge"] === judge)?.detail["verdict"] as Verdict | undefined) ?? null;
  const findings = texts.map((text, i) => ({ n: i + 1, text, model: verdictOf(i + 1, "model"), human: verdictOf(i + 1, "human") }));
  return { block: b.id, refusal: refusal.id, subject: b.subject, ts: refusal.ts, before, findings };
}

/** Every review block of a landed change, oldest first, with each finding's verdicts so far (BR-2253). */
export function judgeableBlocks(db: CoordDb, since = 0, until = Number.MAX_SAFE_INTEGER): JudgeableBlock[] {
  const verdicts = verdictsUpTo(db, Number.MAX_SAFE_INTEGER);
  return reviewBlocks(db, since, until)
    .map((b) => judgeable(db, b, verdicts))
    .filter((b): b is JudgeableBlock => b !== null);
}

/** Blocks with a finding that has no verdict yet, from the model or from a human (BR-2253). */
export const pendingBlocks = (db: CoordDb): JudgeableBlock[] => judgeableBlocks(db).filter((b) => b.findings.some((f) => f.model === null && f.human === null));

export function renderPending(blocks: readonly JudgeableBlock[]): string {
  if (blocks.length === 0) return "(nothing to judge)";
  // reason: the landed commit is not shown: the question is whether the problem existed when blocked, not how it was fixed (D-49)
  return blocks
    .map((b) => [`#${b.block} ${b.subject} ${b.ts.slice(0, 10)}  blocked commit ${b.before}`, ...b.findings.map((f) => `  ${f.n}. model ${f.model ?? "-"} · human ${f.human ?? "-"} · ${f.text}`)].join("\n"))
    .join("\n\n");
}

/**
 * Records one human verdict on one finding (BR-2254). Lookup, the checks and the insert run in one immediate
 * transaction, so two people at once cannot both record a verdict on the same finding.
 */
export function recordVerdict(db: CoordDb, actor: string, blockId: string, finding: string, verdict: string, reason: string): Result<{ subject: string }> {
  if (!(VERDICTS as readonly string[]).includes(verdict)) return err("invalid", `verdict must be real, spurious or unclear, got ${JSON.stringify(verdict)}`);
  const why = reason.trim();
  if (why === "") return err("invalid", "--reason is required: say what in the blocked commit shows the verdict");
  if (!/^[1-9]\d*$/.test(finding)) return err("invalid", `the finding must be its number in the block (1, 2, ...), got ${JSON.stringify(finding)}`);
  if (!/^\d+$/.test(blockId)) return err("invalid", `the block must be a review.block event id (a whole number), got ${JSON.stringify(blockId)}`);
  const n = Number(finding);
  const block = Number(blockId);
  const tx = db.db.transaction((): Result<{ subject: string }> => {
    const b = rows(db, `SELECT ${COLS} FROM events WHERE id = ?`, block)[0];
    const j = b?.kind === "review.block" ? judgeable(db, b, []) : null;
    if (!b || b.kind !== "review.block" || !b.subject) return err("not_found", `event ${block} is not a rule-review block of a change (review.block with a subject)`);
    if (n > findingsOf(b).length) return err("not_found", `block ${block} has ${findingsOf(b).length} finding(s), not ${n}`);
    // reason: canon cannot verify who a human is, so the one thing it enforces is that a Claude Code session never records one (BR-2023, D-49)
    if (actor.startsWith("agent:")) return err("refused", `${actor} is an agent: agent verdicts are not recorded by hand (BR-2254)`);
    const dup = verdictsUpTo(db, Number.MAX_SAFE_INTEGER).find((v) => v.detail["block"] === block && v.detail["finding"] === n && v.detail["judge"] === "human");
    if (dup) return err("conflict", `finding ${n} of block ${block} already has a human verdict (event ${dup.id}, ${dup.detail["verdict"]})`);
    db.event(actor, "review.verdict", b.subject, { block, refusal: j?.refusal ?? null, finding: n, verdict, judge: "human", reason: why, before: typeof b.detail["commit"] === "string" ? b.detail["commit"] : null });
    return ok({ subject: b.subject });
  });
  return tx.immediate();
}

export interface JudgeSummary {
  readonly judge: Judge;
  readonly blocks: number;
  readonly findings: number;
  readonly judged: number;
  readonly real: number;
  readonly spurious: number;
  readonly unclear: number;
}

/** Verdicts on the findings of the judgeable review blocks in the window, per judge, never added together (BR-2255). */
export function verdictSummary(db: CoordDb, since = 0, until = Number.MAX_SAFE_INTEGER): JudgeSummary[] {
  const blocks = judgeableBlocks(db, since, until);
  const ids = new Set(blocks.map((b) => b.block));
  const findings = blocks.reduce((n, b) => n + b.findings.length, 0);
  const vs = verdictsUpTo(db, until).filter((v) => ids.has(v.detail["block"] as number));
  return (["model", "human"] as const).map((judge) => {
    const mine = vs.filter((v) => v.detail["judge"] === judge);
    const of = (x: Verdict) => mine.filter((v) => v.detail["verdict"] === x).length;
    return { judge, blocks: blocks.length, findings, judged: mine.length, real: of("real"), spurious: of("spurious"), unclear: of("unclear") };
  });
}

export function renderVerdictSummary(s: readonly JudgeSummary[]): string | undefined {
  if ((s[0]?.blocks ?? 0) === 0) return undefined;
  const lines = ["review finding verdicts:"];
  for (const j of s) {
    const decided = j.real + j.spurious;
    const tail = decided >= MIN_VERDICTS ? `, spurious share ${((100 * j.spurious) / decided).toFixed(1)}%` : `; fewer than ${MIN_VERDICTS} real or spurious verdicts, no share`;
    lines.push(`  ${j.judge}: ${j.judged} of ${j.findings} findings in ${j.blocks} blocks judged, real ${j.real}, spurious ${j.spurious}, unclear ${j.unclear}${tail}`);
  }
  lines.push("  human verdicts are self-reported: canon cannot tell a person from an agent run outside Claude Code (BR-2023)");
  return lines.join("\n");
}
