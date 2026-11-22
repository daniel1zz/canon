import { openFindings, type OpenFinding } from "../../knowledge/review/findings/findings.ts";
import { questions } from "../humans/questions.ts";
import type { ChangeState } from "../../knowledge/changes/state.ts";
import { pendingRequests } from "../delegation/requests.ts";
import { redMain, revertSettled } from "../watch/redmain.ts";
import { flakyFiles, revertedChanges } from "../watch/revert.ts";
import type { Workspace } from "../workspace.ts";
import type { Change, Corpus } from "../../knowledge/documents/model.ts";
import { executionStates } from "../execution/state.ts";
import { standings, STATE_LABEL as VERDICT_LABEL, type Standing } from "../../knowledge/quality/verdicts.ts";
import { criteriaWithDoc, releasesInProgress, releaseViews } from "../../knowledge/releases/current.ts";
import { uncoveredDecisions } from "../../knowledge/check/commitments.ts";
import { interruptsStalled } from "./interrupt.ts";
import { slowItems } from "./slow.ts";
import { approvalOf, askLine, keepLine } from "../land/owner-gate.ts";

/**
 * The agenda's items (BR-2527, D-151): what the calling session should judge or relay, one item each, with how long it
 * has been open and the command that moves it on. The agenda (agenda.ts) groups, orders, folds and filters them; the
 * change states come from the one place that computes them (BR-2571), never worked out here. Never stored.
 */
export type Group = "judge" | "owner" | "yours";

export interface DueItem {
  /** Stable while the item stays open: `finding:12`, `stalled:C-5`. */
  readonly key: string;
  /** What folds with what (BR-2527): `stalled`, `finding A`, `question`. */
  readonly kind: string;
  /** When the item began, ISO 8601; null when no start is recorded (`-`). */
  readonly since: string | null;
  readonly summary: string;
  readonly next: string;
  /** The next command of a folded line, `<n>` where the number goes. */
  readonly foldNext: string;
  readonly group: Group;
  /** The judge group's order (BR-2527): 0 main's correctness, 1 what blocks others, 2 the rest. */
  readonly tier: 0 | 1 | 2;
  /** Cannot be deferred or marked not doing: a P0 change's interrupt (BR-2606). */
  readonly fixOnly?: boolean;
}

/** `12m`, `3h05m`, `2d4h` (BR-2527); under a minute is `0m`. */
export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** The age of an item, `-` when it has no start (BR-2527). */
export const ageOf = (since: string | null, now: number): string => (since === null ? "-" : age(now - Date.parse(since)));

/** One item as the agenda prints it: `<key> <age> <summary> → <next>` (BR-2527). */
export function renderDue(item: Pick<DueItem, "key" | "since" | "summary" | "next">, now: number = Date.now()): string {
  return `${item.key} ${ageOf(item.since, now)} ${item.summary} → ${item.next}`;
}

const clip = (text: string, n = 120): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The next command for an open finding, by its tier (BR-2502); `id` is `<n>` on a folded line. */
function findingNext(tier: string | null, id: string): string {
  switch (tier) {
    case "A": return `canon finding close ${id} --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    case "B": return `needs another session: canon finding advise ${id} --support|--oppose --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    case "C": return `canon finding ask ${id} --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    default: return `canon finding tier ${id} A|B|C --reason "<why>"`;
  }
}

/** The open findings waiting on the owner's answer to their question: those show as the question instead (BR-2461). */
export function findingsAwaitingOwner(ws: Workspace): Set<number> {
  return new Set(ws.db.db.query<{ id: number }, []>("SELECT f.id FROM review_findings f JOIN questions q ON q.id = f.question WHERE f.closed_at IS NULL AND q.answer IS NULL").all().map((r) => r.id));
}

/** One open finding as an item: a contradiction judges first, a tier-C one is the owner's to answer (BR-2527). */
export function findingItem(f: OpenFinding): DueItem {
  const contradiction = f.criterion === "contradiction";
  const owner = f.tier === "C";
  return {
    key: `finding:${f.id}`,
    kind: contradiction && !owner ? "finding contradiction" : `finding ${f.tier ?? "untriaged"}`,
    since: f.openedAt,
    summary: `${f.tier ? `tier ${f.tier}` : "untriaged"} [${f.criterion}] ${f.ids.length > 0 ? f.ids.join(",") : "-"}: ${clip(f.text)}`,
    next: findingNext(f.tier, String(f.id)),
    foldNext: findingNext(f.tier, "<n>"),
    group: owner ? "owner" : "judge",
    tier: contradiction ? 0 : 2,
  };
}

/** The open findings owed, oldest first, without those waiting on the owner's answer (BR-2461). */
export function findingItems(ws: Workspace): { finding: OpenFinding; item: DueItem }[] {
  const waiting = findingsAwaitingOwner(ws);
  return openFindings(ws.db).filter((f) => !waiting.has(f.id)).map((finding) => ({ finding, item: findingItem(finding) }));
}

/**
 * The changes that landed with rules they execute left without evidence (BR-2241, D-141): the newest `execution.unverified`
 * of each change that is done on main, with the rules of it that are still active and 待重新执行 there.
 */
export function unverifiedItems(ws: Workspace, corpus: Corpus): DueItem[] {
  const rows = ws.db.db
    .query<{ subject: string; ts: string; detail: string }, []>("SELECT subject, ts, detail FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind = 'execution.unverified' AND subject IS NOT NULL GROUP BY subject) ORDER BY id")
    .all();
  if (rows.length === 0) return [];
  const done = new Set(corpus.docs.filter((d) => d.kind === "change" && d.status === "done").map((d) => d.id));
  const named = new Set(rows.filter((r) => done.has(r.subject)).flatMap((r) => ((JSON.parse(r.detail) as { rules?: unknown }).rules as unknown[] | undefined ?? []).map(String)));
  if (named.size === 0) return [];
  const states = executionStates(ws.primary, corpus, ws.config.floorTiming, named);
  const items: DueItem[] = [];
  for (const r of rows) {
    const change = corpus.docs.find((d): d is Change => d.kind === "change" && d.id === r.subject);
    if (change?.status !== "done") continue;
    const rules = ((JSON.parse(r.detail) as { rules?: unknown }).rules as unknown[] | undefined ?? []).map(String).filter((id) => states.get(id)?.kind === "rerun");
    if (rules.length === 0) continue;
    const next = "in a change that lists them in rules:, change a line in a running test whose title names each (or a ## 验收 line for one with untested:) and land --finish (BR-2241)";
    items.push({ key: `unverified:${r.subject}`, kind: "unverified", since: r.ts, summary: `landed with ${rules.join(", ")} 待重新执行: no test or ## 验收 line gave evidence of their current text`, next, foldNext: next, group: "judge", tier: 2 });
  }
  return items;
}

const item = (key: string, kind: string, since: string | null, summary: string, next: string, foldNext: string, group: Group, tier: 0 | 1 | 2): DueItem => ({ key, kind, since, summary, next, foldNext, group, tier });

/** The landed rule reviews that failed and were not run again since (BR-2441): `canon work review-landed --again`. */
function failedReviews(ws: Workspace): DueItem[] {
  const rows = ws.db.db.query<{ change: string | null; head: string; state: string; log: string; queued_at: string; finished_at: string | null }, []>("SELECT change, head, state, log, queued_at, finished_at FROM landed_reviews ORDER BY id").all();
  const done = new Set(rows.filter((r) => r.state === "done").map((r) => r.head));
  return rows
    .filter((r) => r.state === "failed" && !done.has(r.head))
    .map((r) => {
      const subject = r.change ?? r.head.slice(0, 9);
      return item(`review-failed:${subject}`, "review-failed", r.finished_at ?? r.queued_at, `the rule review after its landing could not run (log: ${r.log})`, `canon work review-landed --again ${r.change ?? "<C-n>"}`, "canon work review-landed --again <n>", "judge", 0);
    });
}

/** The quality standards that did not pass or are stale, one item each (BR-2591, D-145); their state is worked out in knowledge/quality (BR-2589). */
export function qualityItems(ws: Workspace, corpus: Corpus): DueItem[] {
  const all = standings(ws, corpus);
  // reason: a state that cannot be read is said, never dropped as if every standard were proven (BR-2591)
  if (!all.ok) return [item("quality:unavailable", "quality-unavailable", null, `the quality standards' verdicts could not be read: ${all.error.message}`, "canon quality status", "canon quality status", "judge", 2)];
  const items: DueItem[] = [];
  for (const s of all.value) {
    if (s.state !== "failed" && s.state !== "stale") continue;
    const v = s.verdict!;
    const said = s.state === "failed" ? `${VERDICT_LABEL.failed} (${v.by}${v.self ? ", self-judged" : ""}, ${v.ts.slice(0, 10)})` : s.commitMissing ? `${VERDICT_LABEL.stale}: its build commit ${v.commit.slice(0, 9)} is gone` : `${VERDICT_LABEL.stale}: ${s.landings} landed on its paths since ${v.ts.slice(0, 10)}, limit ${s.threshold}`;
    const next = `fix, then canon quality verdict ${s.q.id} --result pass --evidence <path>; or canon work handled quality:${s.q.id} --not-doing "<why>"`;
    items.push(item(`quality:${s.q.id}`, s.state === "failed" ? "quality-failed" : "quality-stale", v.ts, `${s.q.id} [${s.q.aspect}] ${clip(s.q.title, 60)}: ${said}`, next, "canon quality verdict <Q-n> --result pass --evidence <path>, or canon work handled quality:<Q-n>", "judge", 2));
  }
  return items;
}

/**
 * A main session's items (BR-2527): what affects main's correctness, what blocks others, the rest; and what waits on the
 * owner. `states` are the change states (BR-2571), `corpus` main's documents.
 */
export function mainItems(ws: Workspace, now: number, states: readonly ChangeState[], corpus: Corpus): DueItem[] {
  const items: DueItem[] = [];
  const red = redMain(ws.db);
  // reason: before the automatic revert has its result a fix change would stop it from locating the landing (BR-2601, BR-2535)
  if (red && red.change === null && revertSettled(ws.db, red)) items.push(item("red-main", "red-main", red.since, `the background floor failed on ${red.sha.slice(0, 9)} (log: ${red.log})`, "canon work start --fix-main", "canon work start --fix-main", "judge", 0));
  // reason: a reverted change waits on its branch until someone fixes and lands it again (BR-2536)
  for (const r of revertedChanges(ws)) items.push(item(`reverted:${r.subject}`, "reverted", r.since, `reverted from main after the background floor failed${r.files.length > 0 ? ` (${r.files.join(", ")})` : " before the tests"}; its work is replayed on change/${r.subject}`, `canon work start ${r.subject}, fix the failure, land again`, "canon work start <n>, fix the failure, land again", "judge", 0));
  items.push(...failedReviews(ws));
  items.push(...findingItems(ws).map((f) => f.item));
  for (const s of states) {
    // reason: a P0 or P1 change's stall is its interrupt item, said once (BR-2606)
    if (s.stalled && !interruptsStalled(s)) items.push(item(`stalled:${s.id}`, "stalled", s.stalled.since, `delegated to ${s.stalled.worker}, no live worker and no commit`, `canon work delegate ${s.id} --to <name> or canon work take ${s.id}`, "canon work delegate <n> --to <name> or canon work take <n>", "judge", 1));
    // reason: a refused landing whose worker is still there is its worker's to fix; only one left with no live claim blocks (BR-2527)
    if (s.state === "land-refused" && !s.flags.claimed) items.push(item(`land-refused:${s.id}`, "land-refused", s.landRefusedAt ?? null, "its landing was refused and no live worker holds it", `canon events --subject ${s.id} --kind land.refuse, then canon work delegate ${s.id} --to <name> or canon work start ${s.id}`, "canon events --subject <n> --kind land.refuse, then delegate or start it", "judge", 1));
    if (s.state === "awaiting-close") items.push(item(`awaiting-close:${s.id}`, "awaiting-close", null, "open on main with no branch or claim, and the rules it lists are active: its work looks done", `canon change close ${s.id} --commit <commit>`, "canon change close <n> --commit <commit>", "judge", 1));
    if (s.state !== "landed" && s.state !== "dropped") {
      for (const w of s.waiting.filter((x) => x.state === "dropped")) items.push(item(`dropped-dep:${s.id}`, "dropped-dep", null, `waits on ${w.id}, dropped without done_by`, `write done_by: <C-n> on ${w.id}, or take ${w.id} out of ${s.id}'s depends_on`, "write done_by on the dropped change, or take it out of depends_on", "judge", 1));
    }
  }
  // reason: a delegated change that has run long or keeps failing its tests is its design owner's to look at (BR-2612, D-157)
  items.push(...slowItems(ws, states, now));
  // reason: a change the owner must approve is said from the moment it is open until they do, so asking is never forgotten (BR-2617, D-158)
  for (const s of states) {
    const gate = s.change?.ownerGate;
    if (gate === undefined || s.state === "landed" || s.state === "dropped") continue;
    const a = approvalOf(ws.db, s.id, gate);
    if (a.approved) continue;
    const before = a.latest ? `; question #${a.latest.id} was answered ${JSON.stringify(a.latest.answer)}${a.latest.owners ? "" : " (not the owner's own answer)"}` : a.stale ? `; question #${a.stale.id} was about an earlier owner_gate text, ${JSON.stringify(clip(a.stale.gate, 40))}, so ask again${a.stale.approved ? `, or keep its approval if the new text asks nothing more: ${keepLine(s.id, a.stale.id)}` : ""}` : "";
    if (a.pending !== undefined) items.push(item(`owner-gate:${s.id}`, "owner-gate", null, `${s.id} needs the owner's approval of: ${clip(gate, 60)}; waiting for the answer to question #${a.pending}`, `ask the owner question #${a.pending} in the conversation, word for word, with the question tool`, "ask the owner the approve question in the conversation", "judge", 2));
    else items.push(item(`owner-gate:${s.id}`, "owner-gate", null, `${s.id} needs the owner's approval of: ${clip(gate, 60)}; ask when it is ready to show${before}`, askLine(s.id, gate), `canon human ask "approve <n>: <owner_gate>?" --option 批准,不批准 --change <n>`, "judge", 2));
  }
  for (const r of pendingRequests(ws.db).filter((r) => r.owner === ws.actor)) {
    items.push(item(`design:${r.subject}`, "design", r.asked_at, `design request #${r.id} from ${r.asked_by}: ${clip(r.request)}`, `canon work design-answer ${r.id} "<answer>"`, `canon work design-answer <n> "<answer>"`, "judge", 1));
  }
  // reason: a rule that landed without evidence is a reminder until it is executed, never a hold (BR-2241, D-141)
  items.push(...unverifiedItems(ws, corpus));
  // reason: a flaky test is a reminder for a week, not a hold (BR-2534)
  for (const f of flakyFiles(ws, now)) items.push(item(`flaky:${f.file}`, "flaky", f.since, "failed in the background floor and passed when run again unchanged", "open an issue for this flaky test (one per file), then fix or quarantine it", "open an issue for each flaky test, then fix or quarantine it", "judge", 2));
  items.push(...qualityItems(ws, corpus));
  // reason: a commitment no rule holds is said until a rule names its decision or the main agent records why not, never a hold (BR-2597, D-154)
  for (const u of uncoveredDecisions(corpus)) {
    const said = `${u.items.length} item(s) of its 决定 name no rule and no active or planned rule names it; first: ${clip(u.items[0]!, 60)}`;
    items.push(item(`commitments:${u.id}`, "commitments", null, `${u.id} ${said}`, `write the rules it commits to (status: planned if not built) naming ${u.id}, or canon work handled commitments:${u.id} --not-doing "<why it commits to no product behaviour>"`, "write rules naming the decision, or canon work handled commitments:<D-n> --not-doing \"<why>\"", "judge", 2));
  }
  for (const q of questions(ws.db, "pending")) {
    items.push(item(`question:${q.id}`, "question", q.asked_at, clip(q.question), `ask the owner in the conversation, then canon human answer ${q.id} "<answer>" --relayed "<their words>"`, `ask the owner, then canon human answer <n> "<answer>" --relayed "<their words>"`, "owner", 2));
  }
  for (const r of releaseViews(corpus, releasesInProgress(corpus))) {
    for (const { doc, c } of criteriaWithDoc(r)) {
      if (c.state !== "owner") continue;
      items.push(item(`criterion:${doc}/${c.id}`, "criterion", null, clip(c.text), `ask the owner whether ${doc}/${c.id} is met, then mark it with the evidence they give`, "ask the owner whether it is met, then mark it", "owner", 2));
    }
  }
  return items;
}

/** The changes a worker holds or was given, by delegation or claim. */
export function workerSubjects(ws: Workspace): string[] {
  return ws.db.db
    .query<{ subject: string }, [string, string]>("SELECT subject FROM delegations WHERE acceptor = ? UNION SELECT subject FROM claims WHERE holder = ? ORDER BY subject")
    .all(ws.actor, ws.actor)
    .map((r) => r.subject);
}

/** The latest event of these kinds on a subject, optionally only one actor's. */
function latest(ws: Workspace, subject: string, kinds: readonly string[], actor?: string): { id: number; ts: string; kind: string; actor: string } | undefined {
  const by = actor === undefined ? "" : " AND actor = ?";
  const params: string[] = [subject, ...kinds, ...(actor === undefined ? [] : [actor])];
  return ws.db.db
    .query<{ id: number; ts: string; kind: string; actor: string }, string[]>(`SELECT id, ts, kind, actor FROM events WHERE subject = ? AND kind IN (${kinds.map(() => "?").join(",")})${by} ORDER BY id DESC LIMIT 1`)
    .get(...params) ?? undefined;
}

/** A worker's items (BR-2527): only about its own changes. */
export function workerItems(ws: Workspace): DueItem[] {
  const items: DueItem[] = [];
  const yours = (key: string, kind: string, since: string, summary: string, next: string) => items.push(item(key, kind, since, summary, next, next, "yours", 2));
  for (const subject of workerSubjects(ws)) {
    const d = ws.db.db.query<{ acceptor: string | null; epoch: number; ended: string | null; owner: string }, [string]>("SELECT acceptor, epoch, ended, owner FROM delegations WHERE subject = ?").get(subject);
    const claim = ws.db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder, delegation_epoch FROM claims WHERE subject = ?").get(subject);
    const accepted = latest(ws, subject, ["delegation.accept"], ws.actor);
    // An answer to the worker's own design request it has not taken in with accept-design yet (BR-2499).
    const answered = ws.db.db
      .query<{ id: number; answered_at: string }, [string, string, string]>("SELECT id, answered_at FROM design_requests WHERE subject = ? AND asked_by = ? AND status = 'answered' AND answered_at > ? ORDER BY id")
      .all(subject, ws.actor, accepted?.ts ?? "");
    if (answered.length > 0) yours(`design-answer:${subject}`, "design-answer", answered[0]!.answered_at, `design request ${answered.map((r) => `#${r.id}`).join(", ")} answered`, `canon work accept-design ${subject}`);
    // Delegated again, or taken back or over by the design owner (BR-2500, BR-2522): said until the worker acts on the change again.
    if (d && d.acceptor === ws.actor) {
      const moved = latest(ws, subject, ["delegation.update", "claim.handover"]);
      const mine = latest(ws, subject, ["delegation.accept", "handoff.write", "claim.release", "land.start"], ws.actor);
      const takenAway = d.ended !== null || (claim != null && claim.holder !== ws.actor);
      const newDesign = claim?.holder === ws.actor && claim.delegation_epoch !== null && claim.delegation_epoch !== d.epoch;
      if (moved && moved.actor !== ws.actor && (!mine || mine.id < moved.id) && (takenAway || newDesign)) {
        if (takenAway) yours(`delegation:${subject}`, "delegation", moved.ts, `taken back by design owner ${d.owner}`, `canon work stop --reason partial --next "<what is left>" --release`);
        else yours(`delegation:${subject}`, "delegation", moved.ts, `delegated again with a new design (epoch ${d.epoch})`, `canon work accept-design ${subject}`);
      }
    }
    // Its own landing refused and not landed since.
    const landing = latest(ws, subject, ["land.ok", "land.refuse"], ws.actor);
    if (landing?.kind === "land.refuse") yours(`land-refused:${subject}`, "land-refused", landing.ts, "your landing was refused", `canon events --subject ${subject} --kind land.refuse, fix what it names, canon work land`);
  }
  return items;
}
