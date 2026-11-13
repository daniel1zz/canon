import { git } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import { executionStates } from "../../work/execution/state.ts";
import { land } from "../../work/land/land.ts";
import { corpusOf, startChore } from "../../work/session/session.ts";
import { openWorkspace, type Say, type Workspace } from "../../work/workspace.ts";
import { findDoc } from "../query/query.ts";
import type { Release } from "../documents/model.ts";
import { setMeta } from "../documents/write.ts";
import { ownerConfirmation, shipBlockers } from "./gate.ts";

/** `canon release ship R-n` (D-61): the conditions, the owner's recorded answer, and the change that lands the snapshot. */

export type ShipOutcome =
  | { readonly kind: "refused"; readonly code: "refused" | "not_found" | "conflict"; readonly message: string }
  | { readonly kind: "landed"; readonly change: string; readonly shippedAt: string; readonly sha: string; readonly tag: string | undefined; readonly tagProblem: string | undefined }
  | { readonly kind: "not-landed"; readonly change: string; readonly timeout: boolean; readonly message: string };

/**
 * Ships a release as its own landed change, the way `canon update` lands its files (D-61): checks everything, records
 * the `release.ship` event the landing requires, writes `status: shipped` and `shipped_at` (main's commit now) into the
 * release, lands it, and tags `release/<id>` at `shipped_at`. A tag that cannot be made is reported, not undone.
 */
export async function shipRelease(ws: Workspace, id: string, timeoutMs: number, say: Say): Promise<Result<ShipOutcome>> {
  // reason: main's commit is taken first and every check reads the rules at that commit, so "what ships" is one commit (D-61, BR-2335)
  const sha = git(ws.primary, "rev-parse", `refs/heads/${ws.config.main}`);
  if (!sha.ok) return sha;
  const onMain = corpusOf(ws, sha.value);
  if (!onMain.ok) return onMain;
  const doc = findDoc(onMain.value, id);
  const refuse = (code: "refused" | "not_found" | "conflict", message: string): Result<ShipOutcome> => ok({ kind: "refused", code, message });
  if (!doc || doc.kind !== "release") return refuse("not_found", `${id} is not a release on ${ws.config.main}`);
  if (doc.status === "shipped") return refuse("conflict", `${id} is already shipped (${doc.shippedAt})`);
  const blockers = shipBlockers(onMain.value, executionStates(ws.primary, onMain.value, ws.config.floorTiming), doc.id);
  if (blockers.length > 0) return refuse("refused", `${doc.id} cannot ship yet (every rule tagged with it must be passed):\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  const confirmed = ownerConfirmation(ws.db, doc.id);
  if (!confirmed.ok) return refuse("refused", confirmed.message);

  const started = startChore(ws, { title: `发布 ${doc.id}：${doc.title}` }, say);
  if (!started.ok) return started;
  const wt = started.value.worktree;
  const change = started.value.change;
  const patched = setMeta(wt, doc as Release, { status: "shipped", shipped_at: sha.value });
  if (!patched.ok) return patched;
  // reason: the landing refuses a release that becomes shipped without this event, so a hand-written `status: shipped` cannot land (BR-2332)
  ws.db.event(ws.actor, "release.ship", change, { release: doc.id, shipped_at: sha.value, question: confirmed.question });
  for (const args of [["add", "-A", "canon"], ["commit", "-q", "-m", `Ship ${doc.id} at ${sha.value.slice(0, 9)} (${change})`]]) {
    const r = git(wt, ...args);
    if (!r.ok) return r;
  }
  const lw = openWorkspace(wt);
  if (!lw.ok) return lw;
  const out = await land(lw.value, { finish: true, timeoutMs }, say);
  if (out.kind !== "landed") {
    const findings = out.kind === "refused" && out.findings ? `\n${out.findings.map((x) => `  ${x.rule} ${x.path}: ${x.message}`).join("\n")}` : "";
    const message = out.kind === "timeout" ? `still ${out.ahead} landing(s) ahead; run \`canon chore land\` in ${wt}` : `${out.reason}: ${out.message}${findings}`;
    return ok({ kind: "not-landed", change, timeout: out.kind === "timeout", message });
  }
  const tag = `release/${doc.id}`;
  const tagged = git(ws.primary, "tag", tag, sha.value);
  return ok({ kind: "landed", change, shippedAt: sha.value, sha: out.sha, tag: tagged.ok ? tag : undefined, tagProblem: tagged.ok ? undefined : tagged.error.message });
}
