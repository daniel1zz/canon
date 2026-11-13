import { git, listWorktreesLocked } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../workspace.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHORE = new RegExp(`^chore-(${UUID})$`, "i");
const CHORE_BRANCH = new RegExp(`^chore/(${UUID})(?:-(.*))?$`, "i");

export function isChore(subject: string | null | undefined): boolean {
  return subject !== null && subject !== undefined && CHORE.test(subject);
}

export function normalizeSubject(subject: string): string {
  return isChore(subject) ? subject.toLowerCase() : subject.toUpperCase();
}

export function branchSubject(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const chore = CHORE_BRANCH.exec(branch);
  if (chore) return `chore-${chore[1]!.toLowerCase()}`;
  return /^change\/(C-\d+)(?:-|$)/i.exec(branch)?.[1]?.toUpperCase();
}

export function subjectBranch(branch: string | undefined, subject: string): boolean {
  return branchSubject(branch) === normalizeSubject(subject);
}

export function choreOffMain(ws: Workspace, subject: string): Result<{ subject: string; branch: string; worktree: string | undefined; slug: string } | undefined> {
  const id = normalizeSubject(subject);
  if (!isChore(id)) return err("invalid", `${subject} is not a chore identity`);
  const refs = git(ws.primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/chore/");
  if (!refs.ok) return refs;
  const branches = refs.value.split("\n").filter((b) => subjectBranch(b, id));
  if (branches.length > 1) return err("conflict", `${id} has more than one branch: ${branches.join(", ")}`);
  if (branches.length === 0) return ok(undefined);
  const branch = branches[0]!;
  const wts = listWorktreesLocked(ws.primary);
  if (!wts.ok) return wts;
  return ok({ subject: id, branch, worktree: wts.value.find((w) => w.branch === branch)?.path, slug: CHORE_BRANCH.exec(branch)?.[2] ?? "" });
}

export function choresInFlight(ws: Workspace): Result<{ subject: string; branch: string }[]> {
  const refs = git(ws.primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/chore/");
  if (!refs.ok) return refs;
  const result: { subject: string; branch: string }[] = [];
  for (const branch of refs.value.split("\n").filter(Boolean)) {
    const subject = branchSubject(branch);
    if (!subject) return err("invalid", `${branch} has an invalid chore identity`);
    const tip = git(ws.primary, "rev-parse", `refs/heads/${branch}`);
    if (!tip.ok) return tip;
    const completed = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'land.ok' AND subject = ? ORDER BY id DESC LIMIT 1").get(subject);
    if (completed && (JSON.parse(completed.detail) as { sha?: string }).sha === tip.value) continue;
    result.push({ subject, branch });
  }
  return ok(result);
}

/** Resolve an existing chore from git even after its claim was released (BR-2457). */
export function choreIn(ws: Workspace): Result<string | undefined> {
  const branch = git(ws.root, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (!branch.ok) return ok(undefined);
  if (!branch.value.startsWith("chore/")) return ok(undefined);
  const subject = branchSubject(branch.value);
  if (!subject || !isChore(subject)) return err("invalid", `${branch.value} is not a recoverable chore branch`);
  const resolved = choreOffMain(ws, subject);
  if (!resolved.ok) return resolved;
  if (!resolved.value || resolved.value.worktree !== ws.root) return err("conflict", `${subject} does not match this worktree`);
  return ok(subject);
}

