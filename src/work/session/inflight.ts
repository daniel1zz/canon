import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
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

/**
 * The changes of `corpus` and of the change branches whose id `corpus` lacks, filtered by `keep`, in the owner's
 * order with started ones (a handoff or a change branch) ahead of the rest (BR-2148, BR-2291).
 */
export function listedChanges(ws: Workspace, corpus: Corpus, backlog: readonly BacklogEntry[], keep: (c: Change) => boolean): Result<ListedChange[]> {
  const branches = changeBranches(ws);
  if (!branches.ok) return branches;
  const local = corpus.docs.filter((d): d is Change => d.kind === "change");
  const known = new Set(local.map((c) => c.id));
  const found = new Map<string, { change: Change; onBranch: string[] }>();
  for (const [id, refs] of branches.value) {
    if (known.has(id)) continue;
    let change: Change | undefined;
    const holding: string[] = [];
    for (const ref of refs) {
      const read = changeOnBranch(ws, id, ref);
      if (!read.ok) return read;
      if (!read.value) continue;
      change ??= read.value;
      holding.push(ref.branch);
    }
    if (change) found.set(id, { change, onBranch: holding });
  }
  const all = [...local, ...[...found.values()].map((f) => f.change)].filter(keep);
  const hs = new Map(handoffs(ws.db).map((h) => [h.subject, h]));
  const started = new Set([...hs.keys(), ...branches.value.keys()]);
  const held = new Set(liveClaims(ws.db).map((c) => c.subject));
  return ok(
    inBacklogOrder(all, backlog, started).map((change) => ({
      change,
      onBranch: found.get(change.id)?.onBranch ?? [],
      handoff: hs.get(change.id),
      claimed: held.has(change.id),
    })),
  );
}

/**
 * How a listed change is marked: `on branch <b>` when only its branch has it, its handoff, `claimed` (BR-2291).
 * `full` writes the handoff's next step (canon change list); the brief keeps its one line short with `handoff`.
 */
export function marksOf(l: ListedChange, full: boolean): string[] {
  const out: string[] = [];
  if (l.onBranch.length) out.push(`on ${l.onBranch.length > 1 ? "branches" : "branch"} ${l.onBranch.join(", ")}`);
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

/**
 * The change file `id` as committed on `ref.commit`, read from git so the branch's worktree, or the branch itself, need
 * not exist any more; undefined when that commit has no such file. A file that is there but does not parse fails
 * loudly, never skipped.
 */
export function changeOnBranch(ws: Workspace, id: string, ref: BranchRef): Result<Change | undefined> {
  const type = changeType(ws);
  const dir = `${CANON_DIR}/${type.dir}/`;
  const branch = ref.branch;
  // reason: read by commit id, not by branch name: the name may be deleted meanwhile (#110), and may hold shell syntax (BR-2107)
  const files = git(ws.primary, "ls-tree", "--name-only", ref.commit, "--", dir);
  if (!files.ok) return files;
  const file = new RegExp(`^${id}(-[a-z0-9-]+)?\\.md$`);
  const path = files.value.split("\n").find((p) => file.test(p.slice(dir.length)));
  if (!path) return ok(undefined);
  const text = git(ws.primary, "show", `${ref.commit}:${path}`);
  if (!text.ok) return text;
  const where = `${path} on branch ${branch}`;
  const parsed = parseDocFile(text.value, where);
  if (!parsed.ok) return err("io", parsed.error.message);
  const { meta, body } = parsed.value;
  const status = meta["status"] ?? type.defaultStatus;
  if (meta["id"] !== id || typeof meta["title"] !== "string" || !type.statuses?.includes(status as string)) {
    return err("io", `${where}: front matter needs id ${id}, a title and a status of ${type.statuses?.join(", ")}`);
  }
  const rules = Array.isArray(meta["rules"]) ? meta["rules"].filter((r): r is string => typeof r === "string") : [];
  return ok({ kind: "change", id, title: meta["title"], path, body, status: status as ChangeStatus, rules, passes: {} });
}

function changeType(ws: Workspace) {
  return ws.config.types.find((t) => t.name === "change")!; // reason: change is a built-in type, never removed
}
