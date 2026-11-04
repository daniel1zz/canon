import type { CoordDb } from "../db.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Verdicts on rule-review blocks (D-35). After a review block the author always edits text, so the fingerprint
 * outcome (BR-2068) says only that something changed; whether the block named a real problem is judged by an
 * executor who took no part in the change, and agent and human verdicts are kept apart.
 */
export type Verdict = "real" | "wording";
export type Judge = "agent" | "human";
export const VERDICTS: readonly Verdict[] = ["real", "wording"];
/** Below this many verdicts of one judge kind no share is reported (BR-2255, D-35). */
export const MIN_VERDICTS = 10;

/** The judge kind follows the executor (BR-2023): an agent is never counted as a human. */
export const judgeOf = (actor: string): Judge => (actor.startsWith("agent:") ? "agent" : "human");

interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly detail: Record<string, unknown>;
}

function rows(db: CoordDb, sql: string, ...params: (string | number)[]): EventRow[] {
  return db.db
    .query<{ id: number; ts: string; actor: string; kind: string; subject: string | null; detail: string }, (string | number)[]>(sql)
    .all(...params)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

const reviewBlocks = (db: CoordDb, since: number, until: number) =>
  rows(db, "SELECT id, ts, actor, kind, subject, detail FROM events WHERE kind = 'land.refuse' AND id > ? AND id <= ? ORDER BY id", since, until).filter((r) => r.detail["reason"] === "review");

const verdictsUpTo = (db: CoordDb, until: number) => rows(db, "SELECT id, ts, actor, kind, subject, detail FROM events WHERE kind = 'review.verdict' AND id <= ? ORDER BY id", until);

/** Whether `actor` wrote any event about `subject` other than a verdict: then it is the change's author (BR-2254). */
function isAuthor(db: CoordDb, subject: string, actor: string): boolean {
  return db.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM events WHERE subject = ? AND actor = ? AND kind != 'review.verdict'").get(subject, actor)!.n > 0;
}

export interface PendingBlock {
  readonly refusal: number;
  readonly subject: string;
  readonly ts: string;
  /** The commit the block saw, found by its fingerprint in the landed range; null when none matches. */
  readonly before: string | null;
  /** The commit the change landed as. */
  readonly after: string | null;
  readonly message: string;
}

/**
 * The commit in `base..sha` whose own diff from `base`, outside canon/changes, has the fingerprint `diff`: the
 * same patch-id the landing computed when it refused (BR-2068, src/work/land/worktree-state.ts ownDiffId).
 */
export function commitWithFingerprint(root: string, base: string, sha: string, diff: string): string | null {
  const list = Bun.spawnSync(["git", "rev-list", "--reverse", `${base}..${sha}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (list.exitCode !== 0) return null;
  for (const c of list.stdout.toString().split("\n").filter(Boolean)) {
    const r = Bun.spawnSync(["sh", "-c", `git diff -U0 "$1" "$2" -- . ':(exclude)canon/changes' | git patch-id --stable`, "sh", base, c], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) continue;
    const id = r.stdout.toString().trim().split(/\s+/)[0] || "empty";
    if (id === diff) return c;
  }
  return null;
}

/** Review blocks of landed changes the acting judge kind has not judged and the actor did not author (BR-2253). */
export function pendingBlocks(db: CoordDb, root: string, actor: string): PendingBlock[] {
  const until = Number.MAX_SAFE_INTEGER;
  const judge = judgeOf(actor);
  const judged = new Set(verdictsUpTo(db, until).filter((v) => v.detail["judge"] === judge).map((v) => v.detail["refusal"]));
  const out: PendingBlock[] = [];
  for (const b of reviewBlocks(db, 0, until)) {
    if (!b.subject || judged.has(b.id) || isAuthor(db, b.subject, actor)) continue;
    const ok = rows(db, "SELECT id, ts, actor, kind, subject, detail FROM events WHERE kind = 'land.ok' AND subject = ? AND id > ? ORDER BY id LIMIT 1", b.subject, b.id)[0];
    if (!ok) continue;
    const sha = ok.detail["sha"];
    // reason: landings before 2026-11-04 recorded no base; main moves only by landing, so the previous
    // landing's commit is where main stood (BR-2253)
    const base = ok.detail["base"] ?? rows(db, "SELECT id, ts, actor, kind, subject, detail FROM events WHERE kind = 'land.ok' AND id < ? ORDER BY id DESC LIMIT 1", ok.id)[0]?.detail["sha"];
    const diff = b.detail["diff"];
    const before = typeof base === "string" && typeof sha === "string" && typeof diff === "string" ? commitWithFingerprint(root, base, sha, diff) : null;
    out.push({ refusal: b.id, subject: b.subject, ts: b.ts, before, after: typeof sha === "string" ? sha : null, message: String(b.detail["message"] ?? "") });
  }
  return out;
}

export function renderPending(blocks: readonly PendingBlock[]): string {
  if (blocks.length === 0) return "(nothing to judge)";
  return blocks
    .map((b) => {
      const head = `#${b.refusal} ${b.subject} ${b.ts.slice(0, 10)}  before ${b.before ?? "?"}  after ${b.after ?? "?"}`;
      return [head, ...b.message.split("\n").map((l) => `    ${l}`)].join("\n");
    })
    .join("\n\n");
}

/**
 * Records one verdict (BR-2254). Lookup, the author and duplicate checks and the insert run in one immediate
 * transaction, so two judges at once cannot both record the same judge kind's verdict.
 */
export function recordVerdict(db: CoordDb, actor: string, refusal: number, verdict: string, reason: string): Result<{ subject: string; judge: Judge }> {
  if (!(VERDICTS as readonly string[]).includes(verdict)) return err("invalid", `verdict must be real or wording, got ${JSON.stringify(verdict)}`);
  const why = reason.trim();
  if (why === "") return err("invalid", "--reason is required: say what in the code before and after the block shows the verdict");
  const judge = judgeOf(actor);
  const tx = db.db.transaction((): Result<{ subject: string; judge: Judge }> => {
    const r = rows(db, "SELECT id, ts, actor, kind, subject, detail FROM events WHERE id = ?", refusal)[0];
    if (!r || r.kind !== "land.refuse" || r.detail["reason"] !== "review") return err("not_found", `event ${refusal} is not a landing refused by the rule review (land.refuse, reason review)`);
    if (!r.subject) return err("not_found", `event ${refusal} records no change, so its author cannot be told apart from a judge`);
    if (isAuthor(db, r.subject, actor)) return err("refused", `${actor} wrote events about ${r.subject}; a verdict must come from an executor who took no part in the change (BR-2254)`);
    const dup = verdictsUpTo(db, Number.MAX_SAFE_INTEGER).find((v) => v.detail["refusal"] === refusal && v.detail["judge"] === judge);
    if (dup) return err("conflict", `refusal ${refusal} already has a ${judge} verdict (event ${dup.id}, ${dup.detail["verdict"]})`);
    db.event(actor, "review.verdict", r.subject, { refusal, verdict, judge, reason: why });
    return ok({ subject: r.subject, judge });
  });
  return tx.immediate();
}

export interface JudgeSummary {
  readonly judge: Judge;
  readonly blocks: number;
  readonly judged: number;
  readonly real: number;
  readonly wording: number;
}

/** Verdicts on the review blocks in the window, per judge kind, never added together (BR-2255). */
export function verdictSummary(db: CoordDb, since = 0, until = Number.MAX_SAFE_INTEGER): JudgeSummary[] {
  const blocks = new Set(reviewBlocks(db, since, until).map((b) => b.id));
  const vs = verdictsUpTo(db, until).filter((v) => blocks.has(v.detail["refusal"] as number));
  return (["agent", "human"] as const).map((judge) => {
    const mine = vs.filter((v) => v.detail["judge"] === judge);
    return { judge, blocks: blocks.size, judged: mine.length, real: mine.filter((v) => v.detail["verdict"] === "real").length, wording: mine.filter((v) => v.detail["verdict"] === "wording").length };
  });
}

export function renderVerdictSummary(s: readonly JudgeSummary[]): string | undefined {
  if ((s[0]?.blocks ?? 0) === 0) return undefined;
  const lines = ["review block verdicts:"];
  for (const j of s) {
    const tail = j.judged >= MIN_VERDICTS ? `, wording share ${((100 * j.wording) / j.judged).toFixed(1)}%` : `; fewer than ${MIN_VERDICTS} verdicts, no share`;
    lines.push(`  ${j.judge}: ${j.judged} of ${j.blocks} judged, real ${j.real}, wording ${j.wording}${tail}`);
  }
  return lines.join("\n");
}
