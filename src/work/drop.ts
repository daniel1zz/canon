import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../app/workspace.ts";
import { ask, claims, dropHandoff, questions, releaseClaim } from "../coord/state.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { git } from "../repo/git.ts";
import { worktreesDir } from "./work.ts";

/**
 * Dropping a change's work in flight (C-8): its worktree, its branch, its claim and its handoff. This is the
 * one sanctioned path for an operation that can lose work (P4). When nothing would be lost it runs at once
 * (BR-2064); otherwise it asks a human through `canon human ask`, deletes nothing (BR-2065), and runs only
 * when a human said yes and nothing changed since the question was asked (BR-2066). It does not intercept
 * an agent using git directly: that would be checking how an agent works, which D-1 rules out.
 */
export type DropOutcome =
  | { readonly kind: "dropped"; readonly worktree: string | null; readonly branch: string | null }
  | { readonly kind: "asked"; readonly question: number; readonly losses: readonly string[] }
  | { readonly kind: "waiting"; readonly question: number }
  | { readonly kind: "declined"; readonly question: number; readonly answer: string };

/** Answers that approve a drop. Anything else declines it. */
const APPROVE = /^(yes|y|同意|是)$/i;

interface Target {
  readonly change: string;
  readonly worktree: string | null;
  readonly branch: string | null;
}

function locate(ws: Workspace, change: string): Result<Target> {
  const path = join(worktreesDir(ws), change);
  const worktree = existsSync(path) ? path : null;
  let branch: string | null = null;
  if (worktree) {
    const b = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
    if (b.ok && b.value !== "HEAD") branch = b.value;
  }
  if (!branch) {
    const list = git(ws.primary, "for-each-ref", "--format=%(refname:short)", `refs/heads/change/${change}`, `refs/heads/change/${change}-*`);
    const names = list.ok && list.value !== "" ? list.value.split("\n") : [];
    branch = names[0] ?? null;
  }
  if (!worktree && !branch) return err("not_found", `${change} has no worktree and no branch; nothing to drop`);
  if (branch === ws.config.main) return err("invalid", `${change}'s worktree has ${ws.config.main} checked out; refusing to delete ${ws.config.main}`);
  return ok({ change, worktree, branch });
}

/** What dropping would lose, one line each; empty when nothing would be lost. Also the fingerprint of the state. */
function losses(ws: Workspace, t: Target): string[] {
  const out: string[] = [];
  if (t.branch) {
    const log = git(ws.primary, "log", "--format=%h %s", `${ws.config.main}..${t.branch}`);
    for (const line of log.ok && log.value !== "" ? log.value.split("\n") : []) out.push(`commit not on ${ws.config.main}: ${line}`);
  }
  if (t.worktree) {
    const st = git(t.worktree, "status", "--porcelain");
    for (const line of st.ok && st.value !== "" ? st.value.split("\n") : []) out.push(`uncommitted: ${line.trim()}`);
  }
  const held = claims(ws.db).find((c) => c.subject === t.change);
  if (held && new Date(held.expires_at) > new Date() && held.actor !== ws.actor) out.push(`claimed by ${held.actor} in ${held.holder} until ${held.expires_at}`);
  return out;
}

export function drop(ws: Workspace, change: string, say: (line: string) => void): Result<DropOutcome> {
  const located = locate(ws, change.toUpperCase());
  if (!located.ok) return located;
  const t = located.value;
  if (t.worktree && ws.root === t.worktree) return err("invalid", `you are in ${t.worktree}; run \`canon work drop ${t.change}\` from another checkout`);
  const lost = losses(ws, t);
  const fingerprint = lost.join("\n");

  if (lost.length > 0) {
    const last = ws.db.db
      .query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'drop.escalate' AND subject = ? ORDER BY id DESC LIMIT 1")
      .get(t.change);
    const prior = last ? (JSON.parse(last.detail) as { question: number; fingerprint: string }) : undefined;
    const q = prior && prior.fingerprint === fingerprint ? questions(ws.db, "all").find((x) => x.id === prior.question) : undefined;
    if (q && q.answer === null) {
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "waiting", question: q.id });
      return ok({ kind: "waiting", question: q.id });
    }
    if (q && q.answer !== null && !(APPROVE.test(q.answer.trim()) && q.answered_by?.startsWith("human:"))) {
      ws.db.event(ws.actor, "drop.refuse", t.change, { reason: "declined", question: q.id, answer: q.answer });
      return ok({ kind: "declined", question: q.id, answer: q.answer });
    }
    if (!q) {
      const text = `Drop ${t.change}? This deletes ${[t.worktree, t.branch && `branch ${t.branch}`].filter(Boolean).join(" and ")} and loses:\n${lost.map((l) => `  - ${l}`).join("\n")}`;
      const id = ask(ws.db, ws.actor, t.change, text, ["yes", "no"]);
      ws.db.event(ws.actor, "drop.escalate", t.change, { question: id, fingerprint, losses: lost });
      return ok({ kind: "asked", question: id, losses: lost });
    }
    say(`#${q.id} approved by ${q.answered_by}; dropping ${t.change}`);
  }

  if (t.worktree) {
    const rm = git(ws.primary, "worktree", "remove", "--force", t.worktree);
    if (!rm.ok) return rm;
  }
  if (t.branch) {
    const del = git(ws.primary, "branch", "-q", "-D", t.branch);
    if (!del.ok) return del;
  }
  releaseClaim(ws.db, t.change, ws.actor);
  dropHandoff(ws.db, t.change);
  ws.db.event(ws.actor, "drop.done", t.change, { worktree: t.worktree, branch: t.branch, losses: lost });
  say(`dropped ${t.change}${t.worktree ? `: removed ${t.worktree}` : ""}${t.branch ? `, deleted branch ${t.branch}` : ""}`);
  return ok({ kind: "dropped", worktree: t.worktree, branch: t.branch });
}
