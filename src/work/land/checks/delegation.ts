import { basename } from "node:path";
import { git } from "../../../kernel/git.ts";
import { parseDocFile } from "../../../knowledge/documents/docfile.ts";
import type { CoordDb } from "../../db.ts";
import { activationOnly, blob, configAt, designPathsOf, hash, taskHashOf } from "../../delegation/delegate.ts";
import { delegation, type ContractItem, type Delegation } from "../../delegation/records.ts";
import { isWorker } from "../../delegation/worker.ts";
import { mayDesign } from "../../delegation/designer.ts";
import { ok, type Result } from "../../../kernel/result.ts";
import { isChore } from "../../session/subject.ts";
import type { Workspace } from "../../workspace.ts";
import { moveMain } from "../finish/finish.ts";

/**
 * The checks a worker's landing passes after the rebase and before main moves (BR-2501, D-128): it changed no design,
 * the design did not change since the delegation, no design request is pending, and its epoch is the delegation's.
 * A lander that is not a worker gets none of them.
 */

/** One landing as these checks see it: its change, who queued it and the epoch its claim had then (BR-2501). */
export interface WorkerLanding {
  readonly subject: string | null;
  readonly actor: string;
  readonly epoch: number | null;
  /** The lander is a worker that may design (BR-2633): its session's profile is in main's `design_profiles` now. */
  readonly designer?: boolean;
}

/** `l` with whether its lander may design, by the profile its session recorded and the list on main as it is now (BR-2633). */
export function withDesigner(ws: Workspace, l: WorkerLanding): Result<WorkerLanding> {
  const may = mayDesign({ ...ws, actor: l.actor });
  return may.ok ? ok({ ...l, designer: may.value }) : may;
}

/** The delegation a worker landing was checked against when main moved: what `land.ok` records (BR-2501, BR-2503). */
export interface DelegationSnapshot {
  readonly lander: string;
  readonly epoch: number;
  readonly owner: string;
  readonly revision: string;
  readonly contract: readonly ContractItem[];
}

export const HAND_BACK = "交回设计负责人：canon work need-design（BR-2499），或由设计负责人 canon work take（BR-2500）";

const CHANGES = "canon/changes/";
const FIXED_DESIGN = ["canon/decisions/", "canon/rules/", "canon/releases/"];
const FIXED_FILES = ["canon/product.md", "canon/config.yaml", "canon/backlog.md"];
/** What a worker that may design still cannot land (BR-2633): the config (it could add itself to the list), the owner's backlog, the product and the releases; `design_paths` too. */
const OWNER_FILES = ["canon/config.yaml", "canon/backlog.md", "canon/product.md"];
const OWNER_DIRS = ["canon/releases/"];

/** A design document's path per the work/delegation glossary, `design_paths` read from main (BR-2501). */
function isDesign(path: string, designPaths: readonly string[], designer = false): boolean {
  if (designer ? OWNER_FILES.includes(path) || OWNER_DIRS.some((d) => path.startsWith(d)) : FIXED_FILES.includes(path) || FIXED_DESIGN.some((d) => path.startsWith(d))) return true;
  return designPaths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/, "")}/`));
}

const idOf = (path: string): string | undefined => /^((?:BR|D)-\d+)\.md$/.exec(basename(path))?.[1];
const named = (path: string): string => (idOf(path) ? `${path} (${idOf(path)})` : path);

/** The 为什么 and 要改什么 sections of a change file's text, hashed as a delegation's task is (BR-2497); undefined when it is not one. */
function taskOf(text: string | undefined, path: string): { id: unknown; chore: unknown; task: string } | undefined {
  if (text === undefined) return undefined;
  const doc = parseDocFile(text, path);
  return doc.ok ? { id: doc.value.meta.id, chore: doc.value.meta["chore"], task: taskHashOf(doc.value.body) } : undefined;
}

/**
 * Item 1: the design documents the candidate (`base`..`head`) adds, changes, deletes or renames. The one exception is
 * activating a planned rule of the contract list; the change file's two sections are compared with the delegation's
 * task hash, not with base. The scope and `design_paths` are read from main, not from the candidate.
 */
function changedDesign(ws: Workspace, subject: string | null, d: Delegation | undefined, t: { base: string; head: string; main: string }, designer = false): string[] | { error: string } {
  const paths = designPathsOf(ws, configAt(ws, t.main));
  if (!paths.ok) return { error: paths.error.message };
  const diff = git(ws.primary, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", t.base, t.head);
  if (!diff.ok) return { error: diff.error.message };
  const contract = new Set((d?.manifest ?? []).filter((i) => i.id?.startsWith("BR-")).map((i) => i.path));
  const found: string[] = [];
  for (const path of diff.value.split("\n").filter((p) => p !== "")) {
    if (path.startsWith(CHANGES) && path.endsWith(".md")) {
      // reason: a worker that may design writes change files, decisions and rules; only the owner's files are checked (BR-2633)
      if (designer) continue;
      const before = blob(ws, t.base, path)?.toString(), after = blob(ws, t.head, path)?.toString();
      const a = taskOf(before, path), b = taskOf(after, path);
      // reason: the worker's own change file is compared with the task the delegation fixed, below (BR-2501)
      if (d && subject !== null && (b?.id === subject || (b === undefined && a?.id === subject))) continue;
      // reason: a chore's light change file is written by its own landing, not by the worker (BR-2501, BR-2458)
      if (subject !== null && isChore(subject) && a === undefined && typeof b?.chore === "string" && b.chore.toLowerCase() === subject.toLowerCase()) continue;
      if (a?.task !== b?.task) found.push(path);
      continue;
    }
    if (!isDesign(path, paths.value, designer)) continue;
    // reason: activating a planned contract rule changes only its status and will_amend; that is not a design edit (BR-2501, BR-2497)
    if (contract.has(path) && activationOnly(blob(ws, t.base, path)?.toString(), blob(ws, t.head, path)?.toString())) continue;
    found.push(named(path));
  }
  if (d && subject !== null && !designer) {
    const file = git(ws.primary, "grep", "-l", `^id: ${subject}$`, t.head, "--", "canon/changes");
    const path = file.ok ? file.value.split("\n")[0]?.replace(/^[^:]+:/, "") : undefined;
    const own = path ? taskOf(blob(ws, t.head, path)?.toString(), path) : undefined;
    if (own?.task !== d.taskHash) found.push(`${path ?? `${subject}'s change file`} (## 为什么 / ## 要改什么 differ from the task delegated)`);
  }
  return found;
}

/** Item 4: the lander is the delegation's acceptor and the landing's epoch is its current one (BR-2501, BR-2497, BR-2500). */
export function staleEpoch(db: CoordDb, l: WorkerLanding): string | undefined {
  if (!isWorker(l.actor) || l.subject === null || isChore(l.subject)) return undefined;
  const d = delegation(db, l.subject);
  // reason: a change a worker that may design opened or took up has no delegation; items 2 and 4 read the delegation record and do not apply (BR-2633)
  if (!d && l.designer) return undefined;
  if (!d) return `4. epoch void: ${l.subject} is not delegated (未派发), so ${l.actor} is no acceptor of it`;
  if (d.ended) return `4. epoch void: the delegation ended when design owner ${d.owner} took ${l.subject} back at ${d.ended} (epoch now ${d.epoch})`;
  if (d.acceptor !== l.actor) return `4. epoch void: ${l.actor} is not the delegation's acceptor (${d.acceptor ?? "none"})`;
  if (l.epoch !== d.epoch) return `4. epoch void: this landing was queued at epoch ${l.epoch ?? "none"}, the delegation is at epoch ${d.epoch}${l.epoch !== null && l.epoch < d.epoch ? " (delegated again or taken back since)" : ""}`;
  return undefined;
}

/**
 * Items 1 to 4 for a worker's landing whose candidate is `head` on `base` (main, or main plus the batch members before
 * it), with `main` the main it lands on; the refusal message, or undefined when it passes or the lander is no worker.
 * A worker chore (started before BR-2498) gets item 1 only.
 */
export function workerLandingRefusal(ws: Workspace, l: WorkerLanding, t: { base: string; head: string; main: string }): string | undefined {
  if (!isWorker(l.actor)) return undefined;
  const chore = isChore(l.subject);
  const d = l.subject !== null && !chore ? delegation(ws.db, l.subject) : undefined;
  const failed: string[] = [];
  const design = changedDesign(ws, l.subject, d, t, l.designer === true);
  if ("error" in design) failed.push(`1. changed design: could not be checked (${design.error})`);
  else if (design.length > 0) failed.push(`1. changed design: ${design.join(", ")}; rule text that must change with the implementation goes back to the design owner`);
  if (!chore && l.subject !== null) {
    const moved = (d?.manifest ?? []).filter((i) => {
      const now = blob(ws, t.base, i.path);
      return now === undefined || hash(now) !== i.hash;
    });
    if (moved.length > 0) failed.push(`2. design changed since the delegation (revision ${d!.revision.slice(0, 9)}): ${moved.map((i) => i.id ?? i.path).join(", ")}; the design owner delegates it again (BR-2497) before it can land`);
    const pending = ws.db.db.query<{ id: number }, [string]>("SELECT id FROM design_requests WHERE subject = ? AND status = 'pending' ORDER BY id").all(l.subject);
    if (pending.length > 0) failed.push(`3. design requests still pending: ${pending.map((p) => `#${p.id}`).join(", ")}`);
    const stale = staleEpoch(ws.db, l);
    if (stale) failed.push(stale);
  }
  if (failed.length === 0) return undefined;
  return `${l.subject ?? "this landing"}: worker ${l.actor} cannot land it (BR-2501):\n${failed.map((f) => `  ${f}`).join("\n")}\n${HAND_BACK}`;
}

/** What a worker landing's delegation is at this moment, for `land.ok` (BR-2501); undefined for any other landing. */
function snapshot(db: CoordDb, l: WorkerLanding): DelegationSnapshot | undefined {
  if (!isWorker(l.actor) || l.subject === null || isChore(l.subject)) return undefined;
  const d = delegation(db, l.subject);
  return d ? { lander: l.actor, epoch: d.epoch, owner: d.owner, revision: d.revision, contract: d.manifest } : undefined;
}

export type GuardedMove =
  | { readonly kind: "moved"; readonly snapshots: ReadonlyMap<string, DelegationSnapshot> }
  | { readonly kind: "stale"; readonly subject: string | null; readonly message: string }
  | { readonly kind: "failed"; readonly reason: "main-moved" | "main-dirty" | "environment"; readonly message: string };

/**
 * Moves main from `expected` to `next` as moveMain does. With worker landings among `landings`, their epochs are checked
 * again in the same coordination-db write transaction that main moves in, so a redelegation or a take (which write in
 * their own immediate transactions) lands either before the check or after main moved, never in between (BR-2501).
 */
export function moveMainGuarded(ws: Workspace, expected: string, next: string, landings: readonly WorkerLanding[]): GuardedMove {
  const workers = landings.filter((l) => isWorker(l.actor));
  const move = (): GuardedMove => {
    const moved = moveMain(ws, expected, next);
    if (moved !== "moved") return { kind: "failed", ...moved };
    const snapshots = new Map<string, DelegationSnapshot>();
    for (const l of workers) {
      const s = snapshot(ws.db, l);
      if (s && l.subject !== null) snapshots.set(l.subject, s);
    }
    return { kind: "moved", snapshots };
  };
  if (workers.length === 0) return move();
  // reason: main moves while this transaction holds the write lock, so no redelegation or take slips between check and move (BR-2501)
  return ws.db.db
    .transaction((): GuardedMove => {
      for (const l of workers) {
        const stale = staleEpoch(ws.db, l);
        if (stale) return { kind: "stale", subject: l.subject, message: `${l.subject}: worker ${l.actor} cannot land it (BR-2501):\n  ${stale}\n${HAND_BACK}` };
      }
      return move();
    })
    .immediate();
}

/** `land.ok`'s record of the delegation a worker landed under (BR-2501). */
export const snapshotDetail = (s: DelegationSnapshot | undefined): Record<string, unknown> => (s ? { delegation: s } : {});
