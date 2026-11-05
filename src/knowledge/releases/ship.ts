import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../kernel/git.ts";
import { ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../../work/db.ts";
import { STATE_LABEL, executionStates, type ExecutionState } from "../../work/execution/state.ts";
import { land } from "../../work/land/land.ts";
import { start, mainCorpus } from "../../work/session/session.ts";
import { openWorkspace, type Say, type Workspace } from "../../work/workspace.ts";
import { findDoc } from "../query/query.ts";
import type { Release } from "../documents/model.ts";
import { setMeta } from "../documents/write.ts";
import { releaseStatuses } from "./status.ts";

/** `canon release ship R-n` (D-61): the conditions, the owner's recorded answer, and the change that lands the snapshot. */

/** The rules tagged with a release that are not passed, each as a line saying what is wrong (empty when it may ship). */
export function shipBlockers(corpus: Parameters<typeof releaseStatuses>[0], states: ReadonlyMap<string, ExecutionState>, id: string): string[] {
  const status = releaseStatuses(corpus, states).find((s) => s.release.id === id);
  if (!status) return [`${id} is not a release`];
  if (status.rules.length === 0) return [`no rule is tagged ${id}: there is no behaviour to ship (a rule says \`release: ${id}\` in its front matter)`];
  return status.rules.filter((r) => r.state !== "passed").map((r) => `${r.id} ${r.title}: ${STATE_LABEL[r.state]}${r.change ? ` (${r.change})` : ""}`);
}

/** The text a question must contain to be about shipping `id`: `ship R-3`, whole (R-3 does not match R-30). */
export const shipQuestion = (id: string): RegExp => new RegExp(`\\bship ${id}(?![0-9])`, "i");

/** What the owner has answered about shipping a release, or why there is no usable answer. */
export type Confirmation = { readonly ok: true; readonly question: number } | { readonly ok: false; readonly message: string };

const YES = /^(yes|y|是|确认|同意)$/i;

interface Row {
  readonly id: number;
  readonly question: string;
  readonly answer: string;
  readonly answered_by: string | null;
  readonly relayed: string | null;
  readonly witness: string | null;
}

/**
 * The most recently answered question that names `ship <id>` decides (BR-2331, D-61): a later `no` revokes an earlier `yes`.
 * It counts when it was answered yes by a human at a terminal, or relayed by an agent whose words match what Claude Code's
 * question tool recorded (witness `match`, BR-2276). Anything else, including no such question, is a refusal that says how to fix it.
 */
export function ownerConfirmation(db: CoordDb, id: string): Confirmation {
  const rows = db.db
    .query<Row, []>("SELECT id, question, answer, answered_by, relayed, witness FROM questions WHERE answer IS NOT NULL ORDER BY answered_at DESC, id DESC")
    .all()
    .filter((r) => shipQuestion(id).test(r.question));
  const how = `ask the owner in the conversation with the question tool, copying the question word for word: canon human ask "ship ${id}: <what ships, the rules and the commit>?" --option yes,no ; then record their words: canon human answer <n> yes --relayed "<their words>"`;
  const latest = rows[0];
  if (!latest) return { ok: false, message: `${id} needs the owner's confirmation: no answered question names \`ship ${id}\`; ${how}` };
  if (!YES.test(latest.answer.trim())) return { ok: false, message: `the owner did not confirm shipping ${id}: question #${latest.id} was answered ${JSON.stringify(latest.answer)}, not yes; ${how}` };
  const byHuman = latest.answered_by?.startsWith("human:") === true && latest.relayed === null;
  if (byHuman || (latest.relayed !== null && latest.witness === "match")) return { ok: true, question: latest.id };
  // reason: a relay canon cannot tie to the question tool's record is an agent's word, not the owner's (BR-2276, D-61)
  return { ok: false, message: `question #${latest.id} (ship ${id}) was answered yes, but the answer is not the owner's: ${latest.relayed === null ? `${latest.answered_by} is not a human` : `the relayed words do not match Claude Code's question-tool record (${latest.witness ?? "not checked"}, BR-2276)`}; ${how}` };
}

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
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return onMain;
  const doc = findDoc(onMain.value, id);
  const refuse = (code: "refused" | "not_found" | "conflict", message: string): Result<ShipOutcome> => ok({ kind: "refused", code, message });
  if (!doc || doc.kind !== "release") return refuse("not_found", `${id} is not a release on ${ws.config.main}`);
  if (doc.status === "shipped") return refuse("conflict", `${id} is already shipped (${doc.shippedAt})`);
  const blockers = shipBlockers(onMain.value, executionStates(ws.primary, onMain.value, ws.config.floorTiming), doc.id);
  if (blockers.length > 0) return refuse("refused", `${doc.id} cannot ship yet (every rule tagged with it must be passed):\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  const confirmed = ownerConfirmation(ws.db, doc.id);
  if (!confirmed.ok) return refuse("refused", confirmed.message);
  const sha = git(ws.primary, "rev-parse", `refs/heads/${ws.config.main}`);
  if (!sha.ok) return sha;

  const started = start(ws, { title: `发布 ${doc.id}：${doc.title}` }, say);
  if (!started.ok) return started;
  const wt = started.value.worktree;
  const change = started.value.change;
  const patched = setMeta(wt, doc as Release, { status: "shipped", shipped_at: sha.value });
  if (!patched.ok) return patched;
  const changeDir = join(wt, "canon", "changes");
  const file = readdirSync(changeDir).find((f) => f === `${change}.md` || f.startsWith(`${change}-`))!;
  const text = readFileSync(join(changeDir, file), "utf8");
  const head = text.slice(0, text.indexOf("---\n", 4) + 4);
  writeFileSync(
    join(changeDir, file),
    `${head}\n## 为什么\n\n负责人确认发布 ${doc.id}（问题 #${confirmed.question}）：标着它的规则全部已通过。\n\n## 要改什么\n\n- ${doc.path}：\`status: shipped\`、\`shipped_at: ${sha.value}\`（发布时 main 的提交）。\n\n## 教训\n\n无。\n\n## 任务\n\n- [x] 由 \`canon release ship\` 写入并合入\n`,
  );
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
    const message = out.kind === "timeout" ? `still ${out.ahead} landing(s) ahead; run \`canon work land --finish\` in ${wt}` : `${out.reason}: ${out.message}${findings}`;
    return ok({ kind: "not-landed", change, timeout: out.kind === "timeout", message });
  }
  const tag = `release/${doc.id}`;
  const tagged = git(ws.primary, "tag", tag, sha.value);
  return ok({ kind: "landed", change, shippedAt: sha.value, sha: out.sha, tag: tagged.ok ? tag : undefined, tagProblem: tagged.ok ? undefined : tagged.error.message });
}
