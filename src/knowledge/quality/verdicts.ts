import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../../work/workspace.ts";
import { isOwnersAnswer } from "../releases/gate.ts";
import type { Corpus, Quality, QualityJudge } from "../documents/model.ts";
import { currentStandards } from "./aspects.ts";

/**
 * Verdicts on quality standards and the state they give (BR-2586 to BR-2590, D-145). A verdict is a `quality.verdict` event;
 * the state is worked out on every read from the latest verdict and the landings after its build commit, never stored
 * (D-151). This is the one place that computes it: the agenda, the start and landing lists, the release lines and the
 * commands read it.
 */

export type Result3 = "pass" | "fail";

export interface Verdict {
  readonly id: number;
  readonly ts: string;
  readonly actor: string;
  readonly commit: string;
  readonly result: Result3;
  readonly by: QualityJudge;
  readonly evidence: string;
  readonly self: boolean;
  readonly question?: number;
  readonly ownerWords?: string;
}

export type VerdictState = "proven" | "failed" | "stale" | "unproven";

export const STATE_LABEL: Readonly<Record<VerdictState, string>> = { proven: "已证明", failed: "不通过", stale: "过期", unproven: "没判过" };

export interface Standing {
  readonly q: Quality;
  readonly state: VerdictState;
  readonly verdict?: Verdict;
  /** The landings after the verdict's build commit on the standard's covered paths (BR-2589); 0 without a verdict. */
  readonly landings: number;
  readonly threshold: number;
  /** The verdict's build commit is not in the repository any more. */
  readonly commitMissing: boolean;
}

const JUDGES: readonly QualityJudge[] = ["test", "agent", "owner"];

/** The latest verdict of each standard, by id (BR-2586: the one recorded last is the current one). */
export function latestVerdicts(ws: Workspace): Map<string, Verdict> {
  const rows = ws.db.db.query<{ id: number; ts: string; actor: string; subject: string; detail: string }, []>("SELECT id, ts, actor, subject, detail FROM events WHERE kind = 'quality.verdict' AND subject IS NOT NULL ORDER BY id").all();
  const out = new Map<string, Verdict>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as Partial<Record<string, unknown>>;
    const result = d["result"];
    const by = d["by"];
    if ((result !== "pass" && result !== "fail") || typeof d["commit"] !== "string" || !JUDGES.includes(by as QualityJudge)) continue;
    out.set(r.subject, {
      id: r.id, ts: r.ts, actor: r.actor, commit: d["commit"], result, by: by as QualityJudge, evidence: typeof d["evidence"] === "string" ? d["evidence"] : "", self: d["self"] === true,
      ...(typeof d["question"] === "number" ? { question: d["question"] } : {}),
      ...(typeof d["owner_words"] === "string" ? { ownerWords: d["owner_words"] } : {}),
    });
  }
  return out;
}

/** The repository paths a standard covers (BR-2589): `all` for `.`, a domain's code directories (its rule directory without any), else the path as written. */
export function coveredPaths(corpus: Corpus, covers: readonly string[]): { readonly all: boolean; readonly paths: readonly string[] } {
  if (covers.some((c) => c === "." || c === "./")) return { all: true, paths: [] };
  const paths = covers.flatMap((c) => {
    const domain = corpus.domains.find((d) => d.name === c);
    if (!domain) return [c.replace(/\/+$/, "")];
    return domain.code.length > 0 ? [...domain.code] : [domain.path];
  });
  return { all: false, paths };
}

/** Whether a changed file is on the covered paths. */
export function touches(spec: ReturnType<typeof coveredPaths>, file: string): boolean {
  return spec.all || spec.paths.some((p) => file === p || file.startsWith(`${p}/`));
}

const lines = (text: string): string[] => text.split("\n").filter((l) => l !== "");

/**
 * The `land.ok` events (landings) whose commits are in `upTo`'s history and not in `from`'s (all of `upTo`'s when there is
 * no `from`) and that changed the covered paths (BR-2589); each landing once, with who landed it. Failure to read git is
 * an error, never a count of zero.
 */
export function landingsOn(ws: Workspace, spec: ReturnType<typeof coveredPaths>, from: string | undefined, upTo: string): Result<{ readonly count: number; readonly actors: ReadonlySet<string> }> {
  const range = from === undefined ? [upTo] : [upTo, `^${from}`];
  const inRange = git(ws.primary, "rev-list", ...range);
  if (!inRange.ok) return inRange;
  const all = new Set(lines(inRange.value));
  const none = { count: 0, actors: new Set<string>() };
  if (all.size === 0) return ok(none);
  let touching = all;
  if (!spec.all) {
    if (spec.paths.length === 0) return ok(none);
    const t = git(ws.primary, "rev-list", ...range, "--", ...spec.paths);
    if (!t.ok) return t;
    touching = new Set(lines(t.value));
    if (touching.size === 0) return ok(none);
  }
  const rows = ws.db.db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM events WHERE kind = 'land.ok' ORDER BY id").all();
  let count = 0;
  const actors = new Set<string>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as { sha?: unknown; base?: unknown };
    if (typeof d.sha !== "string" || !all.has(d.sha)) continue;
    let hit = touching.has(d.sha);
    if (!hit && !spec.all && typeof d.base === "string") {
      // reason: a landing may bring several commits; it counts when any of them is on the covered paths (BR-2589)
      const own = git(ws.primary, "rev-list", `${d.base}..${d.sha}`);
      hit = own.ok && lines(own.value).some((c) => touching.has(c));
    }
    if (!hit) continue;
    count++;
    actors.add(r.actor);
  }
  return ok({ count, actors });
}

const thresholdOf = (ws: Workspace, by: QualityJudge): number => (by === "owner" ? ws.config.qualityStaleOwner : ws.config.qualityStaleAgent);

/** The state of each standard in force, by number (BR-2589). */
export function standings(ws: Workspace, corpus: Corpus): Result<Standing[]> {
  const verdicts = latestVerdicts(ws);
  const tip = `refs/heads/${ws.config.main}`;
  const out: Standing[] = [];
  for (const q of currentStandards(corpus)) {
    const v = verdicts.get(q.id);
    if (!v) { out.push({ q, state: "unproven", landings: 0, threshold: ws.config.qualityStaleAgent, commitMissing: false }); continue; }
    const threshold = thresholdOf(ws, v.by);
    if (v.result === "fail") { out.push({ q, state: "failed", verdict: v, landings: 0, threshold, commitMissing: false }); continue; }
    const found = git(ws.primary, "rev-parse", "--verify", "--quiet", `${v.commit}^{commit}`);
    if (!found.ok || found.value.trim() === "") { out.push({ q, state: "stale", verdict: v, landings: 0, threshold, commitMissing: true }); continue; }
    const n = landingsOn(ws, coveredPaths(corpus, q.covers), v.commit, tip);
    if (!n.ok) return n;
    out.push({ q, state: n.value.count >= threshold ? "stale" : "proven", verdict: v, landings: n.value.count, threshold, commitMissing: false });
  }
  return ok(out);
}

/** The state's line in `canon quality list` and `status` (BR-2590): `判定状态 过期（agent，自评，2026-11-01，abc1234）（之后合入 31/30）`. */
export function standingText(s: Standing): string {
  if (!s.verdict) return `判定状态 ${STATE_LABEL.unproven}`;
  const v = s.verdict;
  const who = [v.by, ...(v.self ? ["自评"] : []), v.ts.slice(0, 10), v.commit.slice(0, 7)].join("，");
  const tail = s.state === "stale" ? (s.commitMissing ? "（构建提交找不到了）" : `（之后合入 ${s.landings}/${s.threshold}）`) : "";
  return `判定状态 ${STATE_LABEL[s.state]}（${who}）${tail}`;
}

export function standingJson(s: Standing): Record<string, unknown> | null {
  const v = s.verdict;
  if (!v) return null;
  return { state: s.state, result: v.result, by: v.by, self: v.self, commit: v.commit, at: v.ts, landings: s.landings, threshold: s.threshold, evidence: v.evidence };
}

/** The overview's line (BR-2590); undefined without a standard in force. */
export function verdictSummary(all: readonly Standing[]): { failed: number; stale: number; unproven: number; proven: number; self: string[] } {
  const n = (k: VerdictState) => all.filter((s) => s.state === k).length;
  return { failed: n("failed"), stale: n("stale"), unproven: n("unproven"), proven: n("proven"), self: all.filter((s) => s.verdict?.self).map((s) => s.q.id) };
}

export function verdictLine(s: ReturnType<typeof verdictSummary>): string {
  const head = `质量判定：不通过 ${s.failed}，过期 ${s.stale}，没判过 ${s.unproven}，已证明 ${s.proven}`;
  return s.self.length > 0 ? `${head}；自评 ${s.self.length} 条（${s.self.join("、")}）` : head;
}

export interface VerdictInput {
  readonly id: string;
  readonly result: string;
  readonly evidence: string;
  readonly commit?: string;
  readonly by?: string;
  readonly question?: number;
}

/** Records a verdict (BR-2586, BR-2587, BR-2588); nothing is recorded on an error. */
export function recordVerdict(ws: Workspace, corpus: Corpus, i: VerdictInput): Result<{ readonly line: string }> {
  const q = corpus.docs.find((d): d is Quality => d.kind === "quality" && d.id === i.id);
  if (!q) return err("not_found", `${i.id} is not a quality standard (canon quality list)`);
  if (q.status === "retired") return err("invalid", `${q.id} is retired: it needs no verdict (BR-2586)`);
  if (i.result !== "pass" && i.result !== "fail") return err("invalid", "--result must be pass or fail (BR-2586)");
  if (i.evidence.trim() === "") return err("invalid", "--evidence is required: the path of the recording, screenshot or report (BR-2586)");
  const by = i.by ?? q.judge;
  if (!JUDGES.includes(by as QualityJudge)) return err("invalid", `--by must be one of ${JUDGES.join(", ")} (BR-2586)`);
  if (by !== q.judge) return err("invalid", `${q.id} is judged by ${q.judge}, not ${by} (BR-2586)`);
  const rev = git(ws.primary, "rev-parse", "--verify", "--quiet", `${i.commit ?? `refs/heads/${ws.config.main}`}^{commit}`);
  if (!rev.ok || rev.value.trim() === "") return err("not_found", `${i.commit ?? ws.config.main} is not a commit in this repository (BR-2586)`);
  const commit = rev.value.trim();
  let question: { readonly id: number; readonly words: string } | undefined;
  if (by === "owner") {
    if (i.question === undefined) return err("invalid", `--by owner needs --question <n>: the canon human question the owner answered for ${q.id} (BR-2587)`);
    const how = `ask the owner in the conversation: canon human ask "${q.id}: <the threshold>, does it pass on ${commit.slice(0, 9)}?" --option pass,fail ; then record it: canon human answer <n> <pass|fail> --relayed "<their words>"`;
    const row = ws.db.db.query<{ question: string; answer: string | null; answered_by: string | null; relayed: string | null; witness: string | null }, [number]>("SELECT question, answer, answered_by, relayed, witness FROM questions WHERE id = ?").get(i.question);
    if (!row) return err("refused", `no question #${i.question}; ${how}`);
    if (row.answer === null) return err("refused", `question #${i.question} is not answered yet; ${how}`);
    if (!new RegExp(`\\b${q.id}(?![0-9])`).test(row.question)) return err("refused", `question #${i.question} does not name ${q.id}; ${how}`);
    const used = ws.db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'quality.verdict'").all().find((e) => (JSON.parse(e.detail) as { question?: unknown }).question === i.question);
    if (used) return err("refused", `question #${i.question} already backs the verdict on ${used.subject}; ${how}`);
    if (!isOwnersAnswer(row)) return err("refused", `question #${i.question} was not answered by the owner (a human at a terminal, or a relay that matches Claude Code's question-tool record, BR-2276); ${how}`);
    question = { id: i.question, words: row.relayed ?? row.answer };
  } else if (i.question !== undefined) {
    return err("invalid", "--question is only for --by owner (BR-2587)");
  }
  let self = false;
  if (by === "agent") {
    const prior = latestVerdicts(ws).get(q.id);
    // reason: no earlier verdict, or one whose commit is gone, sets no lower bound (BR-2588)
    const own = prior ? git(ws.primary, "rev-parse", "--verify", "--quiet", `${prior.commit}^{commit}`) : undefined;
    const from = own?.ok && own.value.trim() !== "" ? own.value.trim() : undefined;
    const landed = landingsOn(ws, coveredPaths(corpus, q.covers), from, commit);
    if (!landed.ok) return landed;
    self = landed.value.actors.has(ws.actor);
  }
  ws.db.event(ws.actor, "quality.verdict", q.id, { commit, result: i.result, by, evidence: i.evidence.trim(), self, ...(question ? { question: question.id, owner_words: question.words } : {}) });
  return ok({ line: `recorded verdict ${q.id} ${i.result} at ${commit.slice(0, 9)} by ${by}${self ? " (self-judged)" : ""}` });
}
