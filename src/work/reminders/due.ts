import { err, ok, type Result } from "../../kernel/result.ts";
import { openFindings, type OpenFinding } from "../../knowledge/review/findings/findings.ts";
import { questions } from "../humans/questions.ts";
import { stalledDelegations } from "../../knowledge/changes/state.ts";
import { pendingRequests } from "../delegation/requests.ts";
import { pressure, readings } from "../delegation/capacity.ts";
import { isWorker } from "../delegation/worker.ts";
import { redMain } from "../watch/redmain.ts";
import { flakyFiles, revertedChanges } from "../watch/revert.ts";
import type { Workspace } from "../workspace.ts";
import type { Change } from "../../knowledge/documents/model.ts";
import { executionStates } from "../execution/state.ts";
import { mainCorpus } from "../session/session.ts";

/**
 * The due list (BR-2527, D-136): what the calling session should handle now, one item each, with how long it has been
 * open and the command that moves it on. `canon work due` prints it, `canon work watch` diffs it, `canon brief` and
 * `canon work start` show parts of it. Worked out on every read, never stored.
 */
export interface DueItem {
  /** Stable while the item stays open: `finding:12`, `stalled:C-5`, `capacity`. */
  readonly key: string;
  /** When the item began, ISO 8601; `now` for an item with no stored start (`capacity`). */
  readonly since: string;
  readonly summary: string;
  readonly next: string;
}

/** What reads the machine; a test passes fixed readings (BR-2526's CANON_MACHINE is read by the default). */
export type Readings = () => ReturnType<typeof readings>;

/** `12m`, `3h05m`, `2d4h` (BR-2527); under a minute is `0m`. */
export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** One item as `canon work due` prints it: `<key> <age> <summary> → <next>`; `since` of `now` is `0m`, or the age since `seen` when given (BR-2528). */
export function renderDue(item: DueItem, now: number = Date.now(), seen?: number): string {
  const start = item.since === "now" ? (seen ?? now) : Date.parse(item.since);
  return `${item.key} ${age(now - start)} ${item.summary} → ${item.next}`;
}

const clip = (text: string, n = 120): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The next command for an open finding, by its tier (BR-2502). */
function findingNext(f: OpenFinding): string {
  switch (f.tier) {
    case "A": return `canon finding close ${f.id} --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    case "B": return `needs another session: canon finding advise ${f.id} --support|--oppose --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    case "C": return `canon finding ask ${f.id} --fixed <commit>|--spurious "<quote>" --reason "<why>"`;
    default: return `canon finding tier ${f.id} A|B|C --reason "<why>"`;
  }
}

/**
 * The open findings owed, oldest first: one waiting on the owner's answer to its question is the owner's and shows as
 * that question instead (BR-2461). `canon work start` lists these (BR-2530).
 */
export function findingItems(ws: Workspace): DueItem[] {
  const waiting = new Set(ws.db.db.query<{ id: number }, []>("SELECT f.id FROM review_findings f JOIN questions q ON q.id = f.question WHERE f.closed_at IS NULL AND q.answer IS NULL").all().map((r) => r.id));
  return openFindings(ws.db)
    .filter((f) => !waiting.has(f.id))
    .map((f) => ({
      key: `finding:${f.id}`,
      since: f.openedAt,
      summary: `${f.tier ? `tier ${f.tier}` : "untriaged"} [${f.criterion}] ${f.ids.length > 0 ? f.ids.join(",") : "-"}: ${clip(f.text)}`,
      next: findingNext(f),
    }));
}

/**
 * The changes that landed with rules they execute left without evidence (BR-2241, D-141): the newest `execution.unverified`
 * of each change that is done on main, with the rules of it that are still active and 待重新执行 there. Main is read only
 * when some change has such an event.
 */
export function unverifiedItems(ws: Workspace): Result<DueItem[]> {
  const rows = ws.db.db
    .query<{ subject: string; ts: string; detail: string }, []>("SELECT subject, ts, detail FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind = 'execution.unverified' AND subject IS NOT NULL GROUP BY subject) ORDER BY id")
    .all();
  if (rows.length === 0) return ok([]);
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const states = executionStates(ws.primary, corpus.value, ws.config.floorTiming);
  const items: DueItem[] = [];
  for (const r of rows) {
    const change = corpus.value.docs.find((d): d is Change => d.kind === "change" && d.id === r.subject);
    if (change?.status !== "done") continue;
    const rules = ((JSON.parse(r.detail) as { rules?: unknown }).rules as unknown[] | undefined ?? []).map(String).filter((id) => states.get(id)?.kind === "rerun");
    if (rules.length === 0) continue;
    items.push({
      key: `unverified:${r.subject}`,
      since: r.ts,
      summary: `landed with ${rules.join(", ")} 待重新执行: no test or ## 验收 line gave evidence of their current text`,
      next: `in a change that lists them in rules:, change a line in a running test whose title names each (or a ## 验收 line for one with untested:) and land --finish (BR-2241)`,
    });
  }
  return ok(items);
}

/** A main session's items (BR-2527): findings, questions, stalled delegations, design requests it owns, a red main, a busy machine. */
function mainItems(ws: Workspace, now: number, read: Readings): Result<DueItem[]> {
  const items: DueItem[] = [...findingItems(ws)];
  for (const q of questions(ws.db, "pending")) {
    items.push({ key: `question:${q.id}`, since: q.asked_at, summary: clip(q.question), next: `ask the owner in the conversation, then canon human answer ${q.id} "<answer>" --relayed "<their words>"` });
  }
  const stalled = stalledDelegations(ws, now);
  if (!stalled.ok) return stalled;
  for (const s of stalled.value) {
    items.push({ key: `stalled:${s.subject}`, since: s.since, summary: `delegated to ${s.worker}, no live worker and no commit`, next: `canon work delegate ${s.subject} --to <name> or canon work take ${s.subject}` });
  }
  for (const r of pendingRequests(ws.db).filter((r) => r.owner === ws.actor)) {
    items.push({ key: `design:${r.subject}`, since: r.asked_at, summary: `design request #${r.id} from ${r.asked_by}: ${clip(r.request)}`, next: `canon work design-answer ${r.id} "<answer>"` });
  }
  const red = redMain(ws.db);
  if (red && red.change === null) {
    items.push({ key: "red-main", since: red.since, summary: `the background floor failed on ${red.sha.slice(0, 9)} (log: ${red.log})`, next: "canon work start --fix-main" });
  }
  // reason: a reverted change waits on its branch until someone fixes and lands it again (BR-2536)
  for (const r of revertedChanges(ws)) items.push({ key: `reverted:${r.subject}`, since: r.since, summary: `reverted from main after the background floor failed${r.files.length > 0 ? ` (${r.files.join(", ")})` : " before the tests"}; its work is replayed on change/${r.subject}`, next: `canon work start ${r.subject}, fix the failure, land again` });
  // reason: a rule that landed without evidence is a reminder until it is executed, never a hold (BR-2241, D-141)
  const unverified = unverifiedItems(ws);
  if (!unverified.ok) return unverified;
  items.push(...unverified.value);
  // reason: a flaky test is a reminder for a week, not a hold (BR-2534)
  for (const f of flakyFiles(ws, now)) items.push({ key: `flaky:${f.file}`, since: f.since, summary: `failed in the background floor and passed when run again unchanged`, next: "open an issue for this flaky test (one per file), then fix or quarantine it" });
  const busy = pressure(ws, read());
  if (busy.length > 0) items.push({ key: "capacity", since: "now", summary: busy.join("; "), next: "wait for workers to land; delegate no new one" });
  return ok(items);
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
function workerItems(ws: Workspace): DueItem[] {
  const items: DueItem[] = [];
  for (const subject of workerSubjects(ws)) {
    const d = ws.db.db.query<{ acceptor: string | null; epoch: number; ended: string | null; owner: string }, [string]>("SELECT acceptor, epoch, ended, owner FROM delegations WHERE subject = ?").get(subject);
    const claim = ws.db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder, delegation_epoch FROM claims WHERE subject = ?").get(subject);
    const accepted = latest(ws, subject, ["delegation.accept"], ws.actor);
    // An answer to the worker's own design request it has not taken in with accept-design yet (BR-2499).
    const answered = ws.db.db
      .query<{ id: number; answered_at: string }, [string, string, string]>("SELECT id, answered_at FROM design_requests WHERE subject = ? AND asked_by = ? AND status = 'answered' AND answered_at > ? ORDER BY id")
      .all(subject, ws.actor, accepted?.ts ?? "");
    if (answered.length > 0) {
      items.push({ key: `design-answer:${subject}`, since: answered[0]!.answered_at, summary: `design request ${answered.map((r) => `#${r.id}`).join(", ")} answered`, next: `canon work accept-design ${subject}` });
    }
    // Delegated again, or taken back or over by the design owner (BR-2500, BR-2522): said until the worker acts on the change again.
    if (d && d.acceptor === ws.actor) {
      const moved = latest(ws, subject, ["delegation.update", "claim.handover"]);
      const mine = latest(ws, subject, ["delegation.accept", "handoff.write", "claim.release", "land.start"], ws.actor);
      const takenAway = d.ended !== null || (claim != null && claim.holder !== ws.actor);
      const newDesign = claim?.holder === ws.actor && claim.delegation_epoch !== null && claim.delegation_epoch !== d.epoch;
      if (moved && moved.actor !== ws.actor && (!mine || mine.id < moved.id) && (takenAway || newDesign)) {
        items.push(takenAway
          ? { key: `delegation:${subject}`, since: moved.ts, summary: `taken back by design owner ${d.owner}`, next: `canon work stop --reason partial --next "<what is left>" --release` }
          : { key: `delegation:${subject}`, since: moved.ts, summary: `delegated again with a new design (epoch ${d.epoch})`, next: `canon work accept-design ${subject}` });
      }
    }
    // Its own landing refused and not landed since.
    const landing = latest(ws, subject, ["land.ok", "land.refuse"], ws.actor);
    if (landing?.kind === "land.refuse") {
      items.push({ key: `land-refused:${subject}`, since: landing.ts, summary: "your landing was refused", next: `canon events --subject ${subject} --kind land.refuse, fix what it names, canon work land` });
    }
  }
  return items;
}

/** The calling session's due list, oldest first by key kind order (BR-2527). */
export function dueItems(ws: Workspace, now: number = Date.now(), read: Readings = readings): Result<DueItem[]> {
  if (isWorker(ws.actor)) return ok(workerItems(ws));
  try {
    return mainItems(ws, now, read);
  } catch (e) {
    // reason: CANON_MACHINE written wrong is a usage error said loudly, never a silent unmeasured machine (BR-2526)
    if (e instanceof Error && /CANON_MACHINE/.test(e.message)) return err("invalid", e.message);
    throw e;
  }
}
