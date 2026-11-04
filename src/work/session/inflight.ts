import { git } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { inBacklogOrder, type BacklogEntry } from "../../knowledge/documents/backlog.ts";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import type { Change, ChangeStatus, Corpus } from "../../knowledge/documents/model.ts";
import { CANON_DIR } from "../../knowledge/documents/read.ts";
import { liveClaims } from "../claims/claims.ts";
import type { Workspace } from "../workspace.ts";
import { handoffs, type Handoff } from "./handoffs.ts";

/**
 * The changes `canon change list` and `canon brief` offer to pick from (BR-2291, D-50): those in a corpus, plus the
 * ones that so far exist only on their own change branch (a change made with --title is on main only once it lands),
 * each with where it lives, its handoff and whether a claim still binds it.
 */
export interface ListedChange {
  readonly change: Change;
  /** The branches its file was read from because the corpus lacks it; empty when the corpus has it. */
  readonly onBranch: readonly string[];
  readonly handoff: Handoff | undefined;
  /** A claim binds it, judged as `canon work start` judges a takeover (BR-2100). */
  readonly claimed: boolean;
}

/** What the listing found: the changes, and the branch files it could not read, each said on its own (BR-2292). */
export interface Listing {
  readonly listed: ListedChange[];
  /** One message per unreadable change file on a branch, naming the file and the branch. */
  readonly unreadable: string[];
}

/**
 * The changes of `corpus` and of the change branches whose id `corpus` lacks, filtered by `keep`, in the owner's
 * order with started ones (a handoff or a change branch) ahead of the rest (BR-2148, BR-2291). A change that only
 * its branch has and that says `done` there is kept whatever `keep` says: its landing never reached main (BR-2294).
 */
export function listedChanges(ws: Workspace, corpus: Corpus, backlog: readonly BacklogEntry[], keep: (c: Change) => boolean): Result<Listing> {
  const branches = changeBranches(ws);
  if (!branches.ok) return branches;
  const local = corpus.docs.filter((d): d is Change => d.kind === "change");
  const known = new Set(local.map((c) => c.id));
  const found = new Map<string, { change: Change; onBranch: string[] }>();
  const unreadable: string[] = [];
  for (const [id, refs] of branches.value) {
    if (known.has(id)) continue;
    let change: Change | undefined;
    const holding: string[] = [];
    for (const ref of refs) {
      const read = changeOnBranch(ws, id, ref);
      if (!read.ok) return read;
      if (!read.value) continue;
      holding.push(ref.branch);
      // reason: one half-done branch must not hide every other change from every session (BR-2292)
      if ("unreadable" in read.value) unreadable.push(read.value.unreadable);
      else change ??= read.value.change;
    }
    if (change) found.set(id, { change, onBranch: holding });
  }
  const offMain = (c: Change) => found.has(c.id) && c.status === "done";
  const all = [...local, ...[...found.values()].map((f) => f.change)].filter((c) => keep(c) || offMain(c));
  const hs = new Map(handoffs(ws.db).map((h) => [h.subject, h]));
  const started = new Set([...hs.keys(), ...branches.value.keys()]);
  const held = new Set(liveClaims(ws.db).map((c) => c.subject));
  return ok({
    listed: inBacklogOrder(all, backlog, started).map((change) => ({
      change,
      onBranch: found.get(change.id)?.onBranch ?? [],
      handoff: hs.get(change.id),
      claimed: held.has(change.id),
    })),
    unreadable,
  });
}

/** The ids whose change file is on their own change branch, for `canon check`: the owner may order them in the backlog (BR-2150). */
export function changeIdsOnBranches(ws: Workspace): Result<Set<string>> {
  const branches = changeBranches(ws);
  if (!branches.ok) return branches;
  const out = new Set<string>();
  for (const [id, refs] of branches.value) {
    for (const ref of refs) {
      const path = changeFileOn(ws, id, ref);
      if (!path.ok) return path;
      if (path.value) out.add(id);
    }
  }
  return ok(out);
}

/**
 * How a listed change is marked (BR-2291, BR-2293, BR-2294): `on branch <b>` when only its branch has it, or `ambiguous: <b>, <b>`
 * when several do (`canon work start` refuses it, BR-2107); `closed on branch, not landed` when that branch says done;
 * its handoff; `claimed`. `full` writes the handoff's next step (canon change list); the brief keeps it to `handoff`.
 */
export function marksOf(l: ListedChange, full: boolean): string[] {
  const out: string[] = [];
  if (l.onBranch.length === 1) out.push(`on branch ${l.onBranch[0]}`);
  if (l.onBranch.length > 1) out.push(`ambiguous: ${l.onBranch.join(", ")}`);
  if (l.onBranch.length && l.change.status === "done") out.push("closed on branch, not landed");
  if (l.handoff) out.push(full ? `handoff: ${l.handoff.next}` : "handoff");
  if (l.claimed) out.push("claimed");
  return out;
}

/** A change branch and the commit it pointed at when listed. */
export interface BranchRef {
  readonly branch: string;
  readonly commit: string;
}

/**
 * Local branches `change/C-n` and `change/C-n-<slug>`, by change id (the names `canon work start` resumes, BR-2107),
 * each with the commit it points at now: reading that commit, not the name, keeps working when another session's
 * drop, clean or undone start deletes the branch while this one is still listing (BR-2291, #110).
 */
function changeBranches(ws: Workspace): Result<Map<string, BranchRef[]>> {
  const prefix = changeType(ws).prefix;
  const refs = git(ws.primary, "for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads/change/");
  if (!refs.ok) return refs;
  const name = new RegExp(`^change/(${prefix}-\\d+)(?:-.*)?$`);
  const out = new Map<string, BranchRef[]>();
  const lines = refs.value.split("\n").filter(Boolean).map((l) => ({ commit: l.slice(0, l.indexOf(" ")), branch: l.slice(l.indexOf(" ") + 1) }));
  for (const ref of lines.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))) {
    const m = ref.branch.match(name);
    if (m) out.set(m[1]!, [...(out.get(m[1]!) ?? []), ref]);
  }
  return ok(out);
}

/** The path of change file `id` in `ref.commit`, undefined when that commit has none. */
function changeFileOn(ws: Workspace, id: string, ref: BranchRef): Result<string | undefined> {
  const dir = `${CANON_DIR}/${changeType(ws).dir}/`;
  // reason: read by commit id, not by branch name: the name may be deleted meanwhile (#110), and may hold shell syntax (BR-2107)
  const files = git(ws.primary, "ls-tree", "--name-only", ref.commit, "--", dir);
  if (!files.ok) return files;
  const file = new RegExp(`^${id}(-[a-z0-9-]+)?\\.md$`);
  return ok(files.value.split("\n").find((p) => file.test(p.slice(dir.length))));
}

/**
 * The change file `id` as committed on `ref.commit`, read from git so the branch's worktree, or the branch itself, need
 * not exist any more; undefined when that commit has no such file. A file that is there but does not parse comes back
 * as `unreadable` with the file and branch named, never skipped silently (BR-2292); a git failure is an error.
 */
export function changeOnBranch(ws: Workspace, id: string, ref: BranchRef): Result<{ change: Change } | { unreadable: string } | undefined> {
  const type = changeType(ws);
  const path = changeFileOn(ws, id, ref);
  if (!path.ok || !path.value) return path.ok ? ok(undefined) : path;
  const text = git(ws.primary, "show", `${ref.commit}:${path.value}`);
  if (!text.ok) return text;
  const where = `${path.value} on branch ${ref.branch}`;
  const parsed = parseDocFile(text.value, where);
  if (!parsed.ok) return ok({ unreadable: parsed.error.message });
  const { meta, body } = parsed.value;
  const status = meta["status"] ?? type.defaultStatus;
  if (meta["id"] !== id || typeof meta["title"] !== "string" || !type.statuses?.includes(status as string)) {
    return ok({ unreadable: `${where}: front matter needs id ${id}, a title and a status of ${type.statuses?.join(", ")}` });
  }
  const rules = Array.isArray(meta["rules"]) ? meta["rules"].filter((r): r is string => typeof r === "string") : [];
  return ok({ change: { kind: "change", id, title: meta["title"], path: path.value, body, status: status as ChangeStatus, rules, passes: {} } });
}

function changeType(ws: Workspace) {
  return ws.config.types.find((t) => t.name === "change")!; // reason: change is a built-in type, never removed
}
