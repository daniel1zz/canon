import { createHash } from "node:crypto";
import { sessionActor, type AgentRuntime } from "../../kernel/agent.ts";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Release } from "../../knowledge/documents/model.ts";
import { CRITERION_LABEL, criteriaCountLine } from "../../knowledge/releases/criteria.ts";
import { effectiveAgentSession } from "../agent-session.ts";
import type { CoordDb } from "../db.ts";
import { allCriteria, headLine, landed, releasesInProgress, releaseViews, type CriterionView } from "../overview/overview.ts";
import { mainCorpus } from "../session/session.ts";
import type { Workspace } from "../workspace.ts";

/** A session's goal mode (BR-2518, BR-2519, D-132). */

export interface Goal {
  readonly releases: readonly string[];
  readonly startedAt: string;
}

/** The session these commands run in, as the goal is keyed, or undefined outside an agent session (BR-2518). */
export function goalActor(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Result<string | undefined> {
  const s = effectiveAgentSession(env, cwd);
  if (!s.ok) return s;
  if (!s.value || s.value.id === "unknown") return ok(undefined);
  // reason: the Stop hook knows only the session, never a child thread, so the goal is the session's (BR-2519)
  return ok(sessionActor(s.value.runtime, s.value.id));
}

export function goalOf(db: CoordDb, actor: string): Goal | undefined {
  const row = db.db.query<{ releases: string; started_at: string }, [string]>("SELECT releases, started_at FROM goals WHERE actor = ?").get(actor);
  return row ? { releases: JSON.parse(row.releases) as string[], startedAt: row.started_at } : undefined;
}

const NO_SESSION = "canon goal is for an agent session (Claude Code or Codex): run it inside one";

/** `canon goal start` (BR-2518): the goal's lines, or why it cannot start. */
export function startGoal(ws: Workspace, actor: string | undefined, ids: readonly string[]): Result<string[]> {
  if (!actor) return err("invalid", NO_SESSION);
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  let picks: Release[];
  if (ids.length > 0) {
    picks = [];
    for (const raw of ids) {
      const id = raw.trim().toUpperCase();
      const r = corpus.value.docs.find((d): d is Release => d.kind === "release" && d.id === id);
      if (!r) return err("not_found", `${id} is not a release`);
      if (r.status === "shipped" || r.status === "dropped") return err("refused", `${id} is ${r.status}: a goal is a release still being built`);
      picks.push(r);
    }
  } else {
    picks = releasesInProgress(corpus.value).map((p) => p.doc);
    if (picks.length === 0) return err("refused", "no release is in progress: create one with canon release new, or mark one with canon release start");
  }
  ws.db.db
    .query("INSERT INTO goals(actor, releases, started_at, marker, stalls) VALUES (?, ?, ?, NULL, 0) ON CONFLICT(actor) DO UPDATE SET releases = excluded.releases, started_at = excluded.started_at, marker = NULL, stalls = 0")
    .run(actor, JSON.stringify(picks.map((r) => r.id)), new Date().toISOString());
  ws.db.event(actor, "goal.start", null, { releases: picks.map((r) => r.id) });
  return goalLines(ws, { releases: picks.map((r) => r.id), startedAt: "" });
}

/** The goal's lines: `goal: R-n, …` and each release's line with its criteria counts (BR-2518). */
export function goalLines(ws: Workspace, goal: Goal): Result<string[]> {
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const views = releaseViews(corpus.value, goal.releases.map((id) => corpus.value.docs.find((d): d is Release => d.kind === "release" && d.id === id)).filter((r): r is Release => r !== undefined).map((doc) => ({ doc, fallback: false })));
  return ok([`goal: ${goal.releases.join(", ")}`, ...views.map((v) => `${headLine(v.doc)}  ${criteriaCountLine(allCriteria(v))}`)]);
}

export function stopGoal(ws: Workspace, actor: string | undefined): Result<string> {
  if (!actor) return err("invalid", NO_SESSION);
  const gone = ws.db.db.query("DELETE FROM goals WHERE actor = ?").run(actor).changes > 0;
  if (gone) ws.db.event(actor, "goal.stop", null, {});
  return ok(gone ? "goal stopped" : "no goal");
}

/** The most criteria the reason names, and how many landings the drift line looks at (BR-2519). */
const NAMED = 5;
const DRIFT_WINDOW = 5;
/** Consecutive holds without progress after which the session is let go (BR-2519). */
const STALL_LIMIT = 3;

/** What the Stop hook prints (BR-2519): always one JSON object. */
export function checkGoal(ws: Workspace, input: string, runtime: AgentRuntime, cwd: string): Record<string, unknown> {
  let session: string;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || !("session_id" in parsed) || typeof parsed.session_id !== "string" || parsed.session_id.trim() === "") return {};
    session = parsed.session_id.trim();
  } catch {
    return {};
  }
  const actor = sessionActor(runtime, session);
  const goal = goalOf(ws.db, actor);
  if (!goal) return {};
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return { systemMessage: `canon goal check failed: ${corpus.error.message}` };
  const releases = goal.releases.map((id) => corpus.value.docs.find((d): d is Release => d.kind === "release" && d.id === id)).filter((r): r is Release => r !== undefined);
  const views = releaseViews(corpus.value, releases.map((doc) => ({ doc, fallback: false })));
  const all = views.flatMap((v) => [...v.criteria.map((c) => ({ doc: v.doc.id, c })), ...[...v.features, ...v.merged].flatMap((f) => f.criteria.map((c) => ({ doc: f.doc.id, c })))]);
  const open = all.filter((x) => x.c.state === "unmet" || x.c.state === "unproven");
  const owner = all.filter((x) => x.c.state === "owner");
  const names = goal.releases.join(", ");
  if (open.length === 0 && owner.length === 0) {
    ws.db.db.query("DELETE FROM goals WHERE actor = ?").run(actor);
    ws.db.event(actor, "goal.reached", null, { releases: goal.releases });
    return { systemMessage: `goal reached: ${names}` };
  }
  if (open.length === 0) return { systemMessage: `goal: only the owner's acceptance is left: ${owner.length} criterion(s)` };
  const marker = progressMarker(ws, cwd);
  const row = ws.db.db.query<{ marker: string | null; stalls: number }, [string]>("SELECT marker, stalls FROM goals WHERE actor = ?").get(actor)!;
  const stalls = row.marker !== null && row.marker === marker ? row.stalls + 1 : 0;
  if (stalls >= STALL_LIMIT) {
    ws.db.db.query("UPDATE goals SET marker = NULL, stalls = 0 WHERE actor = ?").run(actor);
    return { systemMessage: `goal: ${STALL_LIMIT} continuations in a row without progress; stopping, the goal stays (canon goal stop ends it)` };
  }
  ws.db.db.query("UPDATE goals SET marker = ?, stalls = ? WHERE actor = ?").run(marker, stalls, actor);
  const goalRefs = new Set(all.map((x) => `${x.doc}/${x.c.id}`));
  const recent = landed(ws, corpus.value).slice(0, DRIFT_WINDOW);
  const drift = recent.filter((l) => l.advances?.kind !== "criteria" || !l.advances.refs.some((r) => goalRefs.has(r))).length;
  const line = (x: { doc: string; c: CriterionView }) => `- ${x.doc}/${x.c.id} [${CRITERION_LABEL[x.c.state]}] ${x.c.text}${x.c.advancedBy.length > 0 ? `  (advanced by ${x.c.advancedBy.join(", ")})` : ""}`;
  const reason = [
    `Goal (canon goal): ${names} not reached: ${open.length} success criteria still unmet or unproven.`,
    ...open.slice(0, NAMED).map(line),
    "Next: continue a change that advances one of them, or start one with advances: [<doc>/S<k>]; land it, then stop again.",
    ...(drift > 0 ? [`Drift: ${drift} of the last ${recent.length} landed changes advance none of these criteria.`] : []),
  ].join("\n");
  return { decision: "block", reason };
}

/** main's commit, the worktree's HEAD and its uncommitted state, as one string: equal means no progress (BR-2519). */
function progressMarker(ws: Workspace, cwd: string): string {
  const out = (r: Result<string>) => (r.ok ? r.value.trim() : "?");
  const status = out(git(cwd, "status", "--porcelain"));
  return [out(git(ws.primary, "rev-parse", ws.config.main)), out(git(cwd, "rev-parse", "HEAD")), createHash("sha256").update(status).digest("hex")].join(" ");
}
