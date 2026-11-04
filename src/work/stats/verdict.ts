import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CoordDb } from "../db.ts";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * Verdicts on rule-review findings (D-49, superseding D-35). A review block carries several findings, so each
 * finding is judged on its own. A `model` verdict is made by the project's judge command, which canon runs on the
 * blocked commit's tree alone (no fix, no history); a `human` verdict is typed in and self-reported: canon cannot
 * tell a person from an agent run outside Claude Code (BR-2023), so the two are never added together.
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

export interface FindingState {
  readonly n: number;
  readonly text: string;
  readonly model: Verdict | null;
  readonly human: Verdict | null;
}

/** A review block of a change that landed afterwards (BR-2253). */
export interface JudgeableBlock {
  readonly block: number;
  /** The land.refuse this block caused. */
  readonly refusal: number;
  readonly subject: string;
  readonly ts: string;
  /** The commit the block saw, found by its fingerprint in the landed range; null when none matches. */
  readonly before: string | null;
  /** Where main stood when the change landed; the blocked commit's changes are counted from it. */
  readonly base: string | null;
  readonly findings: readonly FindingState[];
}

/** One review block as judgeable, or null when it has no findings or subject, no refusal or never landed (BR-2253). */
function judgeable(db: CoordDb, root: string, b: EventRow, verdicts: readonly EventRow[]): JudgeableBlock | null {
  const texts = findingsOf(b);
  if (!b.subject || texts.length === 0) return null;
  // reason: the landing writes review.block and then returns the refusal, so the block's refusal is the next review refusal of the change (D-49)
  const refusal = rows(db, `SELECT ${COLS} FROM events WHERE kind = 'land.refuse' AND subject = ? AND id > ? ORDER BY id`, b.subject, b.id).find((r) => r.detail["reason"] === "review");
  if (!refusal) return null;
  const landed = rows(db, `SELECT ${COLS} FROM events WHERE kind = 'land.ok' AND subject = ? AND id > ? ORDER BY id LIMIT 1`, b.subject, refusal.id)[0];
  if (!landed) return null;
  const sha = landed.detail["sha"];
  // reason: landings before event 3063 recorded no base; they predate canon sync (D-38), so main moved only by
  // landing and the previous landing's commit is where main stood (BR-2253, D-49)
  const base = landed.detail["base"] ?? rows(db, `SELECT ${COLS} FROM events WHERE kind = 'land.ok' AND id < ? ORDER BY id DESC LIMIT 1`, landed.id)[0]?.detail["sha"];
  const diff = refusal.detail["diff"];
  const before = typeof base === "string" && typeof sha === "string" && typeof diff === "string" ? commitWithFingerprint(root, base, sha, diff) : null;
  const verdictOf = (n: number, judge: Judge) => (verdicts.find((v) => v.detail["block"] === b.id && v.detail["finding"] === n && v.detail["judge"] === judge)?.detail["verdict"] as Verdict | undefined) ?? null;
  const findings = texts.map((text, i) => ({ n: i + 1, text, model: verdictOf(i + 1, "model"), human: verdictOf(i + 1, "human") }));
  return { block: b.id, refusal: refusal.id, subject: b.subject, ts: refusal.ts, before, base: typeof base === "string" ? base : null, findings };
}

/** Every review block of a landed change, oldest first, with each finding's verdicts so far (BR-2253). */
export function judgeableBlocks(db: CoordDb, root: string): JudgeableBlock[] {
  const verdicts = verdictsUpTo(db, Number.MAX_SAFE_INTEGER);
  return reviewBlocks(db, 0, Number.MAX_SAFE_INTEGER)
    .map((b) => judgeable(db, root, b, verdicts))
    .filter((b): b is JudgeableBlock => b !== null);
}

/** Blocks with a finding still missing a model or a human verdict (BR-2253). */
export const pendingBlocks = (db: CoordDb, root: string): JudgeableBlock[] => judgeableBlocks(db, root).filter((b) => b.findings.some((f) => f.model === null || f.human === null));

/** The pending list as `--json` prints it: no base, which only the judge run needs (BR-2253). */
export const pendingJson = (blocks: readonly JudgeableBlock[]) => blocks.map(({ block, refusal, subject, ts, before, findings }) => ({ block, refusal, subject, ts, before, findings }));

export function renderPending(blocks: readonly JudgeableBlock[]): string {
  if (blocks.length === 0) return "(nothing to judge)";
  // reason: the landed commit is not shown: the question is whether the problem existed when blocked, not how it was fixed (D-49)
  return blocks
    .map((b) => [`#${b.block} ${b.subject} ${b.ts.slice(0, 10)}  blocked commit ${b.before ?? "?"}`, ...b.findings.map((f) => `  ${f.n}. model ${f.model ?? "-"} · human ${f.human ?? "-"} · ${f.text}`)].join("\n"))
    .join("\n\n");
}

/**
 * Records one human verdict on one finding (BR-2254). Lookup, the checks and the insert run in one immediate
 * transaction, so two people at once cannot both record a verdict on the same finding.
 */
export function recordVerdict(db: CoordDb, root: string, actor: string, blockId: string, finding: string, verdict: string, reason: string): Result<{ subject: string }> {
  if (!(VERDICTS as readonly string[]).includes(verdict)) return err("invalid", `verdict must be real, spurious or unclear, got ${JSON.stringify(verdict)}`);
  const why = reason.trim();
  if (why === "") return err("invalid", "--reason is required: say what in the blocked commit shows the verdict");
  if (!/^[1-9]\d*$/.test(finding)) return err("invalid", `the finding must be its number in the block (1, 2, ...), got ${JSON.stringify(finding)}`);
  if (!/^\d+$/.test(blockId)) return err("invalid", `the block must be a review.block event id (a whole number), got ${JSON.stringify(blockId)}`);
  const n = Number(finding);
  const block = Number(blockId);
  // reason: finding the blocked commit runs git, so it happens before the write transaction, not inside it
  const first = rows(db, `SELECT ${COLS} FROM events WHERE id = ?`, block)[0];
  const j = first?.kind === "review.block" ? judgeable(db, root, first, []) : null;
  const tx = db.db.transaction((): Result<{ subject: string }> => {
    const b = rows(db, `SELECT ${COLS} FROM events WHERE id = ?`, block)[0];
    if (!b || b.kind !== "review.block" || !b.subject) return err("not_found", `event ${block} is not a rule-review block of a change (review.block with a subject)`);
    if (n > findingsOf(b).length) return err("not_found", `block ${block} has ${findingsOf(b).length} finding(s), not ${n}`);
    // reason: canon cannot verify who a human is, so the one thing it enforces is that a Claude Code session never records one (BR-2023, D-49)
    if (actor.startsWith("agent:")) return err("refused", `${actor} is an agent: agent verdicts are made blind by canon verdict run (BR-2290), not typed in`);
    const dup = verdictsUpTo(db, Number.MAX_SAFE_INTEGER).find((v) => v.detail["block"] === block && v.detail["finding"] === n && v.detail["judge"] === "human");
    if (dup) return err("conflict", `finding ${n} of block ${block} already has a human verdict (event ${dup.id}, ${dup.detail["verdict"]})`);
    db.event(actor, "review.verdict", b.subject, { block, refusal: j?.refusal ?? null, finding: n, verdict, judge: "human", reason: why, before: j?.before ?? null });
    return ok({ subject: b.subject });
  });
  return tx.immediate();
}

/** The judge's prompt: the change, the files it had changed and the findings; never the fix (BR-2290). */
export function judgePrompt(b: JudgeableBlock, changed: readonly string[]): string {
  return [
    "You judge whether the findings of a rule review were right. The current directory holds the project's files exactly as they were when the review blocked change " + b.subject + "; there is no git history.",
    `Files the change had modified at that point:\n${changed.length ? changed.map((p) => `- ${p}`).join("\n") : "(none recorded)"}`,
    "For each finding below, decide from these files alone whether the problem it describes exists: real (it exists), spurious (it does not), unclear (the files cannot tell).",
    'Answer with JSON only: {"verdicts":[{"finding":<number>,"verdict":"real"|"spurious"|"unclear","reason":"<one sentence>"}]}, exactly one entry per finding.',
    `# Findings\n\n${b.findings.map((f) => `${f.n}. ${f.text}`).join("\n")}`,
  ].join("\n\n");
}

/** The judge's answer, or why it does not hold: one entry per finding, a known verdict and a reason each (BR-2290). */
export function parseJudge(out: string, count: number): Result<{ finding: number; verdict: Verdict; reason: string }[]> {
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return err("io", `printed no JSON: ${out.trim().slice(0, 300)}`);
  let v: unknown;
  try {
    v = JSON.parse(match[0]);
  } catch (e) {
    return err("io", `JSON does not parse: ${(e as Error).message}`);
  }
  const list = (v as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) return err("io", "no verdicts array");
  const got = new Map<number, { finding: number; verdict: Verdict; reason: string }>();
  for (const e of list as unknown[]) {
    const x = e as { finding?: unknown; verdict?: unknown; reason?: unknown };
    if (typeof x.finding !== "number" || !Number.isInteger(x.finding) || x.finding < 1 || x.finding > count) return err("io", `finding ${JSON.stringify(x.finding)} is not one of 1..${count}`);
    if (!(VERDICTS as readonly unknown[]).includes(x.verdict)) return err("io", `finding ${x.finding}: verdict ${JSON.stringify(x.verdict)} is not real, spurious or unclear`);
    if (typeof x.reason !== "string" || x.reason.trim() === "") return err("io", `finding ${x.finding}: no reason`);
    if (got.has(x.finding)) return err("io", `finding ${x.finding} answered twice`);
    got.set(x.finding, { finding: x.finding, verdict: x.verdict as Verdict, reason: x.reason.trim() });
  }
  if (got.size !== count) return err("io", `answered ${got.size} of ${count} findings`);
  return ok([...got.values()].sort((a, b) => a.finding - b.finding));
}

/** The command with a leading path relative to the worktree made absolute: it runs in the exported tree (BR-2290). */
export function resolveCommand(command: string, root: string): string {
  const m = command.match(/^(\S+)([\s\S]*)$/);
  if (!m) return command;
  const head = m[1]!;
  if (isAbsolute(head) || !head.includes("/")) return command;
  const full = join(root, head);
  // reason: the exported tree holds the blocked commit's copy of the script, not the current one (BR-2290)
  return existsSync(full) && statSync(full).isFile() ? `'${full.replace(/'/g, "'\\''")}'${m[2]}` : command;
}

function git(root: string, ...args: string[]): Result<string> {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? ok(r.stdout.toString()) : err("io", `git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
}

export interface RunLine {
  readonly block: number;
  readonly subject: string;
  readonly findings: number;
  readonly prompt: number;
  readonly counts?: Readonly<Record<Verdict, number>>;
}

export interface RunReport {
  readonly dryRun: boolean;
  readonly lines: readonly RunLine[];
  readonly skipped: number;
  /** Why the run stopped early, naming the block; undefined when every block went through. */
  readonly failure?: string;
}

/**
 * Judges up to `limit` blocks with the project's judge command, each on its blocked commit's tree exported
 * without .git, and records a model verdict per finding not yet judged (BR-2290).
 */
export async function runVerdicts(db: CoordDb, root: string, actor: string, command: string, limit: number, dryRun: boolean): Promise<RunReport> {
  const open = judgeableBlocks(db, root).filter((b) => b.findings.some((f) => f.model === null));
  const skipped = open.filter((b) => b.before === null).length;
  const lines: RunLine[] = [];
  for (const b of open.filter((x) => x.before !== null).slice(0, limit)) {
    const changed = b.base ? git(root, "-c", "core.quotePath=false", "diff", "--name-only", b.base, b.before!) : ok("");
    const prompt = judgePrompt(b, changed.ok ? changed.value.split("\n").filter(Boolean) : []);
    if (dryRun) {
      lines.push({ block: b.block, subject: b.subject, findings: b.findings.length, prompt: prompt.length });
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), "canon-judge-"));
    try {
      const exported = Bun.spawnSync(["sh", "-c", `git archive "$1" | tar -x -C "$2"`, "sh", b.before!, dir], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (exported.exitCode !== 0) return { dryRun, lines, skipped, failure: `block ${b.block}: could not export ${b.before}: ${exported.stderr.toString().trim()}` };
      const proc = Bun.spawn(["sh", "-c", resolveCommand(command, root)], { cwd: dir, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
      const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) return { dryRun, lines, skipped, failure: `block ${b.block}: the judge command exited ${code}: ${errText.trim().slice(0, 500)}` };
      const parsed = parseJudge(out, b.findings.length);
      if (!parsed.ok) return { dryRun, lines, skipped, failure: `block ${b.block}: the judge command's answer does not hold: ${parsed.error.message}` };
      const counts: Record<Verdict, number> = { real: 0, spurious: 0, unclear: 0 };
      db.db
        .transaction(() => {
          const have = new Set(verdictsUpTo(db, Number.MAX_SAFE_INTEGER).filter((v) => v.detail["block"] === b.block && v.detail["judge"] === "model").map((v) => v.detail["finding"]));
          for (const v of parsed.value) {
            // reason: another run may have judged this finding meanwhile; one model verdict per finding (BR-2290)
            if (have.has(v.finding)) continue;
            db.event(actor, "review.verdict", b.subject, { block: b.block, refusal: b.refusal, finding: v.finding, verdict: v.verdict, judge: "model", reason: v.reason, before: b.before, command });
            counts[v.verdict]++;
          }
        })
        .immediate();
      lines.push({ block: b.block, subject: b.subject, findings: b.findings.length, prompt: prompt.length, counts });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { dryRun, lines, skipped };
}

export function renderRun(r: RunReport): string {
  const out = r.lines.map((l) =>
    l.counts ? `#${l.block} ${l.subject}: real ${l.counts.real}, spurious ${l.counts.spurious}, unclear ${l.counts.unclear} (prompt ${l.prompt} characters)` : `#${l.block} ${l.subject}: ${l.findings} finding(s), prompt ${l.prompt} characters`,
  );
  const findings = r.lines.reduce((n, l) => n + (l.counts ? l.counts.real + l.counts.spurious + l.counts.unclear : l.findings), 0);
  out.push(`${r.dryRun ? "would judge" : "judged"} ${r.lines.length} block(s), ${findings} finding(s); ${r.skipped} block(s) without a blocked commit skipped; prompts ${r.lines.reduce((n, l) => n + l.prompt, 0)} characters`);
  return out.join("\n");
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

/** Verdicts on the findings of the review blocks in the window, per judge, never added together (BR-2255). */
export function verdictSummary(db: CoordDb, since = 0, until = Number.MAX_SAFE_INTEGER): JudgeSummary[] {
  const blocks = reviewBlocks(db, since, until);
  const ids = new Set(blocks.map((b) => b.id));
  const findings = blocks.reduce((n, b) => n + findingsOf(b).length, 0);
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
