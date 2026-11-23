import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { backlogAt, type BacklogEntry } from "../documents/backlog.ts";
import type { Change, Corpus, Doc } from "../documents/model.ts";
import { isPlaceholderLine, section } from "../documents/templates.ts";
import { waitingMark, type Waiting } from "./deps.ts";
import { liveClaims } from "../../work/claims/claims.ts";
import { activationOnly, blob, configAt, contractWanted, designPathsOf } from "../../work/delegation/delegate.ts";
import { stallCandidates, type StalledDelegation } from "../../work/delegation/stall.ts";
import { activeQueue } from "../../work/land/queue/queue.ts";
import { firstLine, handoffs, reasonText, type Handoff } from "../../work/session/handoffs.ts";
import { changeOnBranch, listedChanges, type BranchRef, type ListedChange } from "../../work/session/inflight.ts";
import { mainCorpus } from "../../work/session/session.ts";
import { assignedTiers, tierIndex, type Assigned } from "../../work/priority/store.ts";
import { DEFAULT_TIER } from "../../work/priority/tiers.ts";
import type { Workspace } from "../../work/workspace.ts";

/**
 * The state of every change (BR-2571, D-151): one primary state by a fixed precedence, plus flags, worked out on every
 * read from what commands wrote down: the change files on main and on the change branches, the coordination database
 * (claims, delegations, landing queue, handoffs, questions, events) and git commit times. Never from the text of a
 * handoff, a note or a change's body beyond whether its two task sections are empty. Every command that shows a change's
 * state reads it from here: change list, brief, work status, work due, overview, the delegation slots.
 */

/** The primary states, in the order they are decided: the first that holds is the change's state (BR-2571). */
export const STATES = [
  "landed",
  "dropped",
  "missing",
  "awaiting-close",
  "in-queue",
  "land-refused",
  "in-progress",
  "stalled",
  "delegated",
  "waiting-owner",
  "waiting-deps",
  "handed-off",
  "ready-delegatable",
  "ready-self",
] as const;
export type StateName = (typeof STATES)[number];

/** The flags that hold alongside the primary state, each on its own (BR-2571). */
export interface Flags {
  readonly handoff: boolean;
  readonly deps_unmet: boolean;
  readonly owner_question: boolean;
  readonly claimed: boolean;
  readonly ambiguous: boolean;
  readonly closed_on_branch: boolean;
  /** The scope may overlap another change's; always false until D-148 step D fills it. */
  readonly overlap: boolean;
}

export interface ChangeState {
  readonly id: string;
  /** Its file as listed (this checkout's, main's or its branch's); undefined when only the coordination data has it. */
  readonly change: Change | undefined;
  /** The branches its file was read from because the listed corpus lacks it (BR-2291). */
  readonly onBranch: readonly string[];
  readonly state: StateName;
  readonly flags: Flags;
  readonly handoff: Handoff | undefined;
  /** Its dependencies not satisfied on main's latest commit, criteria the owner holds included (BR-2564). */
  readonly waiting: readonly Waiting[];
  /** Unanswered questions about it (asked with --change, or in its worktree). */
  readonly ownerQuestions: readonly number[];
  /** Its delegation in force, if any. */
  readonly delegation: { readonly worker: string; readonly owner: string; readonly epoch: number } | undefined;
  /** BR-2522's stall, when its delegation is stalled and the change is not closed. */
  readonly stalled: StalledDelegation | undefined;
  /** When its latest landing event was a refusal (state `land-refused`). */
  readonly landRefusedAt: string | undefined;
  /** For `ready-self`, why it cannot be delegated; empty otherwise. */
  readonly notDelegatable: readonly string[];
  /** It has a change branch (started once), whether or not main has it too (BR-2570's in progress). */
  readonly hasBranch: boolean;
  /** Its tier when one is set and it is not closed (BR-2602, BR-2603); undefined is the default P2. */
  readonly priority: Assigned | undefined;
}

/** A change state with its file: every listed change has one, only the coordination-only ones lack it. */
export type Filed = ChangeState & { readonly change: Change };
export const hasFile = (s: ChangeState): s is Filed => s.change !== undefined;

export interface States {
  /** The listed changes by tier, P0 first, each tier in the owner's order (BR-2604, BR-2148, BR-2291), then the ones only the coordination data has, by id. */
  readonly states: readonly ChangeState[];
  /** The branch files that could not be read, one message each (BR-2292). */
  readonly unreadable: readonly string[];
}

export interface StatesOptions {
  /** The corpus the changes are listed from; main's latest commit by default (`canon change list` passes this checkout's). */
  readonly corpus?: Corpus;
  /** The owner's order; main's `canon/backlog.md` by default. */
  readonly backlog?: readonly BacklogEntry[];
  readonly now?: number;
  /** Split ready into delegatable and self (reads the design items on main and the branches); default true. */
  readonly delegatable?: boolean;
}

const CLOSED: ReadonlySet<StateName> = new Set(["landed", "dropped"]);
/** Whether the state is closed: the change will not be worked on again (BR-2571). */
export const isClosed = (s: Pick<ChangeState, "state">): boolean => CLOSED.has(s.state);

export function changeStates(ws: Workspace, opts: StatesOptions = {}): Result<States> {
  const main = mainCorpus(ws);
  if (!main.ok) return main;
  const corpus = opts.corpus ?? main.value;
  let backlog = opts.backlog;
  if (!backlog) {
    const read = backlogAt(ws.primary, ws.config.main, ws.config.types);
    if (!read.ok) return read;
    backlog = read.value;
  }
  const listing = listedChanges(ws, corpus, backlog, () => true, main.value);
  if (!listing.ok) return listing;
  const now = opts.now ?? Date.now();
  const facts = readFacts(ws, now);
  if (!facts.ok) return facts;
  const f = facts.value;
  const onMain = new Map(main.value.docs.filter((d): d is Change => d.kind === "change" && listing.value.onMain.has(d.id)).map((c) => [c.id, c]));
  const mainDocs = new Map(main.value.docs.map((d) => [d.id, d]));
  const design = opts.delegatable === false ? undefined : lazyDesign(ws, main.value, mainDocs);
  const listedStates: ChangeState[] = [];
  for (const l of listing.value.listed) {
    const s = stateOf(ws, l, onMain.get(l.change.id), listing.value.branches.get(l.change.id) ?? [], mainDocs, f, design);
    if (!s.ok) return s;
    // reason: a landed or dropped change's tier has no effect and is not shown (BR-2603, D-155)
    listedStates.push(isClosed(s.value) ? s.value : { ...s.value, priority: f.tiers.get(s.value.id) });
  }
  // reason: the tier only reorders; Array.prototype.sort is stable, so each tier keeps the owner's order (BR-2604, BR-2148)
  const rank = (s: ChangeState) => tierIndex(s.priority?.tier ?? DEFAULT_TIER);
  const out = listedStates.sort((a, b) => rank(a) - rank(b));
  // reason: a change only the coordination data names (a branch-only change dropped since, a deleted branch) still has a state, or a stale delegation would show as stalled forever (BR-2571, C-671)
  const listed = new Set(out.map((s) => s.id));
  const prefix = ws.config.types.find((t) => t.name === "change")!.prefix; // reason: change is a built-in type, never removed
  const changeId = new RegExp(`^${prefix}-\\d+$`);
  const extra = [...new Set([...f.coordinated])].filter((id) => changeId.test(id) && !listed.has(id) && !onMain.has(id) && !listing.value.branches.has(id));
  for (const id of extra.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))) out.push(withoutFile(id, f));
  return ok({ states: out, unreadable: listing.value.unreadable });
}

/** The coordination facts every change's state reads, read once. */
interface Facts {
  readonly claimed: ReadonlySet<string>;
  readonly queued: ReadonlySet<string>;
  readonly lastLanding: ReadonlyMap<string, { kind: string; ts: string }>;
  readonly dropDone: ReadonlySet<string>;
  readonly everClaimed: ReadonlySet<string>;
  readonly delegations: ReadonlyMap<string, { worker: string; owner: string; epoch: number }>;
  readonly stalls: ReadonlyMap<string, StalledDelegation>;
  readonly questions: ReadonlyMap<string, number[]>;
  readonly handoffs: ReadonlyMap<string, Handoff>;
  /** Every subject the coordination data names: delegations (ended too), live claims, handoffs, drops. */
  readonly coordinated: readonly string[];
  /** The tiers set, the fix change's P0 included (BR-2602). */
  readonly tiers: ReadonlyMap<string, Assigned>;
}

function readFacts(ws: Workspace, now: number): Result<Facts> {
  const q = <T>(sql: string) => ws.db.db.query<T, []>(sql).all();
  const stalls = stallCandidates(ws, now);
  if (!stalls.ok) return stalls;
  const questions = new Map<string, number[]>();
  // reason: a question with a provisional answer stays the owner's, but its change no longer waits on it (BR-2636, D-163)
  for (const r of q<{ id: number; subject: string }>("SELECT id, subject FROM questions WHERE answer IS NULL AND withdrawn IS NULL AND provisional IS NULL AND subject IS NOT NULL ORDER BY id")) questions.set(r.subject, [...(questions.get(r.subject) ?? []), r.id]);
  const claimed = new Set(liveClaims(ws.db).map((c) => c.subject));
  const allDelegations = q<{ subject: string; worker: string; owner: string; epoch: number; ended: string | null }>("SELECT subject, worker, owner, epoch, ended FROM delegations");
  const hs = new Map(handoffs(ws.db).map((h) => [h.subject, h]));
  const dropDone = new Set(q<{ subject: string }>("SELECT DISTINCT subject FROM events WHERE kind = 'drop.done' AND subject IS NOT NULL").map((r) => r.subject));
  return ok({
    claimed,
    queued: new Set(activeQueue(ws.db).flatMap((e) => (e.subject ? [e.subject] : []))),
    lastLanding: new Map(
      q<{ subject: string; kind: string; ts: string }>("SELECT subject, kind, ts FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE kind IN ('land.start', 'land.ok', 'land.refuse') AND subject IS NOT NULL GROUP BY subject)").map((r) => [r.subject, { kind: r.kind, ts: r.ts }]),
    ),
    dropDone,
    everClaimed: new Set(q<{ subject: string }>("SELECT DISTINCT subject FROM events WHERE kind = 'claim.take' AND subject IS NOT NULL").map((r) => r.subject)),
    delegations: new Map(allDelegations.filter((d) => d.ended === null).map((d) => [d.subject, { worker: d.worker, owner: d.owner, epoch: d.epoch }])),
    stalls: new Map(stalls.value.map((s) => [s.subject, s])),
    questions,
    handoffs: hs,
    coordinated: [...allDelegations.map((d) => d.subject), ...claimed, ...hs.keys(), ...dropDone],
    tiers: assignedTiers(ws.db),
  });
}

const flagsOf = (id: string, f: Facts, waiting: readonly Waiting[], onBranch: readonly string[], change: Change | undefined): Flags => ({
  handoff: f.handoffs.has(id),
  deps_unmet: waiting.length > 0,
  owner_question: (f.questions.get(id) ?? []).length > 0,
  claimed: f.claimed.has(id),
  ambiguous: onBranch.length > 1,
  closed_on_branch: onBranch.length > 0 && change?.status === "done",
  overlap: false,
});

/** A change no file has, only the coordination data: dropped when a drop removed it, else missing (BR-2571 2, 3). */
function withoutFile(id: string, f: Facts): ChangeState {
  const delegation = f.delegations.get(id);
  return {
    id,
    change: undefined,
    onBranch: [],
    state: f.dropDone.has(id) ? "dropped" : "missing",
    flags: flagsOf(id, f, [], [], undefined),
    handoff: f.handoffs.get(id),
    waiting: [],
    ownerQuestions: f.questions.get(id) ?? [],
    delegation,
    stalled: f.dropDone.has(id) ? undefined : f.stalls.get(id),
    landRefusedAt: undefined,
    notDelegatable: [],
    hasBranch: false,
    priority: undefined,
  };
}

function stateOf(ws: Workspace, l: ListedChange, main: Change | undefined, branches: readonly BranchRef[], mainDocs: ReadonlyMap<string, Doc>, f: Facts, design: Design | undefined): Result<ChangeState> {
  const id = l.change.id;
  const delegation = f.delegations.get(id);
  const questions = f.questions.get(id) ?? [];
  const landing = f.lastLanding.get(id);
  const base = { id, priority: undefined, hasBranch: branches.length > 0 || l.onBranch.length > 0, change: l.change, onBranch: l.onBranch, flags: flagsOf(id, f, l.waiting, l.onBranch, l.change), handoff: f.handoffs.get(id), waiting: l.waiting, ownerQuestions: questions, delegation };
  const done = (state: StateName, extra: Partial<ChangeState> = {}): Result<ChangeState> =>
    ok({ ...base, state, stalled: CLOSED.has(state) ? undefined : f.stalls.get(id), landRefusedAt: undefined, notDelegatable: [], ...extra });
  if (main?.status === "done") return done("landed");
  if (main?.status === "dropped") return done("dropped");
  // reason: a file this checkout has counts as a file; only a change no file has anywhere is dropped or missing (BR-2571)
  if (!main && branches.length === 0 && l.onBranch.length === 0 && f.dropDone.has(id)) return done("dropped");
  if (main?.status === "open" && branches.length === 0 && !f.claimed.has(id) && f.everClaimed.has(id) && main.rules.length > 0 && main.rules.every((r) => { const d = mainDocs.get(r); return d?.kind === "rule" && d.status === "active"; })) return done("awaiting-close");
  // reason: a light change's file is written at its chore's landing, so before main has it its chore's queue entry and claim tell its state (BR-2571, BR-2458)
  const chore = l.change.chore;
  if (chore !== undefined && !main) {
    if (f.queued.has(chore)) return done("in-queue");
    if (f.claimed.has(chore)) return done("in-progress");
  }
  if (f.queued.has(id)) return done("in-queue");
  if (landing?.kind === "land.refuse") return done("land-refused", { landRefusedAt: landing.ts });
  if (f.claimed.has(id)) return done("in-progress");
  if (delegation) return done(f.stalls.has(id) ? "stalled" : "delegated");
  if (questions.length > 0 || l.waiting.some((w) => w.state === "owner")) return done("waiting-owner");
  if (l.waiting.length > 0) return done("waiting-deps");
  if (base.handoff) return done("handed-off");
  // reason: a file closed only on its branch or in this checkout has not landed; it is no design to hand a worker (BR-2571, BR-2294)
  if (l.change.status !== "open") return done("ready-self", { notDelegatable: [`${l.change.status} ${l.onBranch.length > 0 ? "on its branch" : "in this checkout"}, not landed on ${ws.config.main}`] });
  if (!design) return done("ready-self", { notDelegatable: ["not worked out"] });
  const gaps = design.gaps(l.change, branches);
  if (!gaps.ok) return gaps;
  return gaps.value.length === 0 ? done("ready-delegatable") : done("ready-self", { notDelegatable: gaps.value });
}

interface Design {
  /** Why `change` cannot be delegated now, empty when it can (BR-2571 13, BR-2497). */
  gaps(change: Change, branches: readonly BranchRef[]): Result<string[]>;
}

const filled = (text: string | undefined): boolean => text !== undefined && text.split("\n").some((l) => l.trim() !== "" && !isPlaceholderLine(l));

/** The design check of ready changes, reading main's tree and `design_paths` only when the first ready change asks. */
function lazyDesign(ws: Workspace, main: Corpus, mainDocs: ReadonlyMap<string, Doc>): Design {
  let ctx: { files: ReadonlySet<string>; extra: readonly string[] } | undefined;
  const load = (): Result<{ files: ReadonlySet<string>; extra: readonly string[] }> => {
    if (ctx) return ok(ctx);
    // reason: a main with no commit yet has no design published, so nothing on it is delegatable
    const born = git(ws.primary, "rev-parse", "--verify", "-q", `${ws.config.main}^{commit}`).ok;
    const tree = born ? git(ws.primary, "ls-tree", "-r", "--name-only", ws.config.main) : ok("");
    if (!tree.ok) return err("io", `cannot list ${ws.config.main}'s files to tell delegatable changes: ${tree.error.message}`);
    const paths = born ? designPathsOf(ws, configAt(ws, ws.config.main)) : ok([]);
    if (!paths.ok) return paths;
    ctx = { files: new Set(tree.value.split("\n").filter(Boolean)), extra: paths.value };
    return ok(ctx);
  };
  return {
    gaps(listed, branches) {
      const c = load();
      if (!c.ok) return c;
      const out: string[] = [];
      if (branches.length > 1) return ok([`on ${branches.length} branches`]);
      let change = listed;
      const ref = branches[0];
      // reason: a delegation reads the task from the change's branch when it has one (BR-2497)
      if (ref) {
        const read = changeOnBranch(ws, listed.id, ref);
        if (!read.ok) return read;
        if (read.value && "change" in read.value) change = read.value.change;
      }
      for (const h of ["## 为什么", "## 要改什么"]) if (!filled(section(change.body, h))) out.push(`${h} is empty`);
      const { wanted, unpublished } = contractWanted((id) => mainDocs.get(id), main.types, change, c.value.extra);
      const missing = [...unpublished];
      const changed: string[] = [];
      let diff: Set<string> | undefined;
      if (ref) {
        const base = git(ws.primary, "merge-base", ws.config.main, ref.commit);
        if (!base.ok) return base;
        const names = git(ws.primary, "diff", "--name-only", base.value, ref.commit);
        if (!names.ok) return names;
        diff = new Set(names.value.split("\n").filter(Boolean));
        for (const [path, docId] of wanted) {
          if (!diff.has(path)) continue;
          // reason: activating a planned rule on the branch is not a design edit (BR-2497, BR-2501)
          if (docId?.startsWith("BR-") && activationOnly(blob(ws, base.value, path)?.toString(), blob(ws, ref.commit, path)?.toString())) continue;
          changed.push(docId ?? path);
        }
      }
      for (const [path, docId] of wanted) if (!c.value.files.has(path)) missing.push(docId ?? path);
      for (const m of [...new Set(missing)]) out.push(`${m} not on ${ws.config.main}`);
      for (const m of changed) out.push(`${m} changed on its branch`);
      return ok(out);
    },
  };
}

/** The states' detail after the name, as `canon change list` writes it (BR-2572); undefined when the name is all. */
function stateDetail(s: ChangeState): string | undefined {
  switch (s.state) {
    case "handed-off": return s.handoff ? reasonText(s.handoff) : undefined;
    case "waiting-owner": return [...s.ownerQuestions.map((n) => `#${n}`), ...s.waiting.filter((w) => w.state === "owner").map((w) => w.id)].join(", ");
    case "delegated":
    case "stalled": return s.delegation?.worker;
    case "ready-self": return s.notDelegatable.join(", ");
    default: return undefined;
  }
}

/** The state mark: `handed-off: land`, `ready-delegatable` (BR-2572). */
export function stateMark(s: ChangeState): string {
  const d = stateDetail(s);
  return d ? `${s.state}: ${d}` : s.state;
}

/**
 * How a listed change is marked (BR-2291, BR-2293, BR-2294, BR-2564, BR-2572): with `full` (canon change list) its state
 * first and the handoff's next step; the brief and the overview keep the handoff to `handoff` and leave the state out.
 */
export function marksOf(s: ChangeState, full: boolean): string[] {
  const out: string[] = full ? [stateMark(s)] : [];
  if (s.onBranch.length === 1) out.push(`on branch ${s.onBranch[0]}`);
  if (s.onBranch.length > 1) out.push(`ambiguous: ${s.onBranch.join(", ")}`);
  if (s.flags.closed_on_branch) out.push("closed on branch, not landed");
  if (s.handoff) out.push(full ? `handoff: ${firstLine(s.handoff.next)}` : "handoff");
  if (s.flags.claimed) out.push("claimed");
  const waiting = waitingMark(s.waiting);
  if (waiting) out.push(waiting);
  return out;
}

/** The keys `canon change list --json` adds for a change's state (BR-2572). */
export function stateJson(s: ChangeState): Record<string, unknown> {
  return {
    state: s.state,
    flags: s.flags,
    owner_questions: s.ownerQuestions,
    delegation: s.delegation ? { ...s.delegation, stalled_since: s.stalled?.since ?? null } : null,
    land_refused_at: s.landRefusedAt ?? null,
    not_delegatable: s.notDelegatable,
  };
}

/** The delegated changes stalled at `now` and not closed (BR-2522, BR-2571): BR-2522's conditions on a change that is not landed or dropped. */
export function stalledDelegations(ws: Workspace, now: number = Date.now()): Result<StalledDelegation[]> {
  const all = changeStates(ws, { now, delegatable: false });
  if (!all.ok) return all;
  return ok(all.value.states.flatMap((s) => (s.stalled ? [s.stalled] : [])).sort((a, b) => (a.subject < b.subject ? -1 : 1)));
}
