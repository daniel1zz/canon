import { agentSession } from "../../../kernel/agent.ts";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { CoordDb } from "../../../work/db.ts";
import { ask, awaiting } from "../../../work/humans/questions.ts";
import { isWorker } from "../../../work/delegation/worker.ts";
export { isWorker };
import { attachedDocs, docsAt } from "./docs.ts";
import { quotedIn } from "./close.ts";

/**
 * Who may settle an open review finding (D-118, #216): tier A the session alone, tier B with another session's support,
 * tier C the owner. A finding starts untriaged; the session sets its tier with a reason (BR-2477), and `canon finding close`
 * asks for the tier's evidence (BR-2478): an advisor's `canon finding advise` (BR-2479) or the owner's answer to the
 * question `canon finding ask` recorded, or to an older question that covers it (BR-2480). A person outside an agent
 * session is the owner and closes any tier with BR-2453's evidence alone.
 *
 * canon reads the session from the host environment, never from `--as` or CANON_ACTOR, so a session cannot name another
 * as its advisor by a flag; an agent that rewrites its own environment is not stopped (as for relayed answers, BR-2021).
 */
export type Tier = "A" | "B" | "C";
export const TIERS: readonly Tier[] = ["A", "B", "C"];
const RANK: Record<Tier, number> = { A: 0, B: 1, C: 2 };

/** Who is running the command, from the host environment only (D-118). */
export interface Caller {
  /** `<runtime>:<session>[:<child>]` inside an agent session, `human:<name>` outside one. */
  readonly key: string;
  /** Outside any agent session: a person, who is the owner here. */
  readonly human: boolean;
  /** The session a subagent belongs to: `<runtime>:<session>`, the key itself for a top-level session or a person (#225). */
  readonly root: string;
  /** Why this caller cannot advise, when it cannot: a subagent, a delegated worker, or a session canon cannot name. */
  readonly notIndependent?: string;
}

/** The refusal BR-2502 gives a worker that tries to tier, close or amend a finding. */
export function workerRefusal(actor: string, verb: string): Result<never> {
  return err("invalid", `${actor} is a worker and cannot ${verb} review findings: they sit on design documents and belong to the design owner; hand the ones you think matter to it with canon work need-design (BR-2502, D-128)`);
}

/** The session an advice key belongs to: its first two parts, `<runtime>:<session>` (#225). */
const rootOf = (key: string): string => key.split(":").slice(0, 2).join(":");

export function callerOf(env: Record<string, string | undefined>, actor: string): Caller {
  const s = agentSession(env);
  if (!s) return { key: actor, root: actor, human: actor.startsWith("human:") };
  const key = `${s.runtime}:${s.id}${s.child ? `:${s.child}` : ""}`;
  // reason: a subagent or a worker its session launched answers to that session; its support is not a second opinion (D-118)
  const notIndependent = s.child ? "a subagent" : env["CLAUDE_DELEGATE_CHILD"] === "1" ? "a delegated worker" : s.id === "unknown" ? "a session canon cannot name (no CLAUDE_CODE_SESSION_ID)" : undefined;
  return { key, root: `${s.runtime}:${s.id}`, human: false, ...(notIndependent ? { notIndependent } : {}) };
}

interface FindingRow {
  id: number;
  tier: string | null;
  closed_at: string | null;
  question: number | null;
  criterion: string;
  ids: string;
  docs: string;
  text: string;
}

function findingNumber(raw: string): Result<number> {
  const s = raw.replace(/^#/, "");
  const n = Number(s);
  return /^\d+$/.test(s) && Number.isSafeInteger(n) && n > 0 ? ok(n) : err("invalid", `the finding number must be a positive whole number, got ${JSON.stringify(raw)}`);
}

/** The finding by number. A closed one is accepted too: its closing can be corrected with `canon finding amend` under the same tier (BR-2483). */
function findingRow(db: CoordDb, raw: string): Result<FindingRow> {
  const n = findingNumber(raw);
  if (!n.ok) return n;
  const row = db.db.query<FindingRow, [number]>("SELECT id, tier, closed_at, question, criterion, ids, docs, text FROM review_findings WHERE id = ?").get(n.value);
  if (!row) return err("not_found", `review finding #${n.value} does not exist`);
  return ok(row);
}

/** `canon finding tier` (BR-2477): sets or raises a finding's tier with a reason; only a person outside an agent session lowers one. */
export function setTier(db: CoordDb, input: { readonly actor: string; readonly caller: Caller; readonly id: string; readonly tier: string; readonly reason: string }): Result<{ id: number; from: Tier | null; to: Tier }> {
  if (isWorker(input.actor)) return workerRefusal(input.actor, "tier");
  const to = input.tier.toUpperCase();
  if (!(TIERS as readonly string[]).includes(to)) return err("invalid", `the tier is A, B or C, got ${JSON.stringify(input.tier)}`);
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say why the finding is this tier");
  // reason: the tier read, the no-lowering check and the write are one transaction, so a raise committed meanwhile is seen (#223, #224)
  return db.db
    .transaction((): Result<{ id: number; from: Tier | null; to: Tier }> => {
      const row = findingRow(db, input.id);
      if (!row.ok) return row;
      const from = row.value.tier as Tier | null;
      if (from !== null && RANK[to as Tier] < RANK[from] && !input.caller.human) return err("refused", `#${row.value.id} is tier ${from}: a session only raises a tier; the owner lowers one (from a terminal outside an agent session)`);
      db.db.query("UPDATE review_findings SET tier = ?, tier_reason = ? WHERE id = ?").run(to, reason, row.value.id);
      db.event(input.actor, "finding.tier", null, { finding: row.value.id, from, to, reason });
      return ok({ id: row.value.id, from, to: to as Tier });
    })
    .immediate();
}

/** How a close settles a finding, as advice and owner questions bind it: the full commit, or the squashed quote. */
export interface Target {
  readonly how: "fixed" | "spurious";
  readonly target: string;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function targetOf(cwd: string, fixed: string | undefined, spurious: string | undefined): Result<Target> {
  if ((fixed === undefined) === (spurious === undefined)) return err("invalid", "give exactly one of --fixed <commit> and --spurious \"<quote>\"");
  if (fixed !== undefined) {
    const c = git(cwd, "rev-parse", "--verify", "--quiet", `${fixed}^{commit}`);
    if (!c.ok || c.value === "") return err("not_found", `--fixed ${fixed}: no such commit`);
    return ok({ how: "fixed", target: c.value });
  }
  const q = squash(spurious ?? "");
  if (q === "") return err("invalid", "--spurious needs the quote");
  return ok({ how: "spurious", target: q });
}

const describe = (t: Target): string => (t.how === "fixed" ? `fixed by ${t.target.slice(0, 9)}` : `spurious, quoting ${JSON.stringify(t.target)}`);

/** `canon finding advise` (BR-2479): another session's support for, or objection to, one way of closing a finding. */
export function advise(db: CoordDb, input: { readonly cwd: string; readonly main: string; readonly actor: string; readonly caller: Caller; readonly id: string; readonly verdict: "support" | "oppose"; readonly fixed?: string; readonly spurious?: string; readonly reason: string }): Result<{ id: number; target: Target }> {
  if (input.caller.notIndependent) return err("refused", `canon finding advise: this is ${input.caller.notIndependent}; advice comes from a session of its own`);
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say why this close holds or does not");
  const first = findingRow(db, input.id);
  if (!first.ok) return first;
  const t = targetOf(input.cwd, input.fixed, input.spurious);
  if (!t.ok) return t;
  const at = mainAt(input.cwd, input.main);
  if (!at.ok) return at;
  // reason: git is read before the write lock; the documents' versions are what this advice judged (#226)
  const stamp = docsAt(input.cwd, at.value, attachedDocs(first.value.docs, first.value.criterion));
  return db.db
    .transaction((): Result<{ id: number; target: Target }> => {
      const row = findingRow(db, input.id);
      if (!row.ok) return row;
      db.db.query("INSERT INTO finding_advice(finding, session, actor, verdict, how, target, reason, at, docs_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.value.id, input.caller.key, input.actor, input.verdict, t.value.how, t.value.target, reason, new Date().toISOString(), stamp);
      db.event(input.actor, "finding.advise", null, { finding: row.value.id, session: input.caller.key, verdict: input.verdict, how: t.value.how, target: t.value.target, reason, main: at.value });
      return ok({ id: row.value.id, target: t.value });
    })
    .immediate();
}

/** `main` resolved to one commit, so every git read of one decision sees the same tree (#226). */
export function mainAt(cwd: string, main: string): Result<string> {
  const c = git(cwd, "rev-parse", "--verify", "--quiet", `${main}^{commit}`);
  return c.ok && c.value !== "" ? ok(c.value) : err("io", `${main} does not resolve to a commit`);
}

export const APPROVE = "approve: close it this way";
export const REJECT = "reject: do not close it this way";

/** `canon finding ask` (BR-2480): records the owner question that approves one way of closing a finding. */
export function askOwner(db: CoordDb, input: { readonly cwd: string; readonly main: string; readonly actor: string; readonly id: string; readonly fixed?: string; readonly spurious?: string; readonly reason: string }): Result<{ question: number; text: string; target: Target }> {
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say what the close does, for the owner to judge");
  const first = findingRow(db, input.id);
  if (!first.ok) return first;
  const t = targetOf(input.cwd, input.fixed, input.spurious);
  if (!t.ok) return t;
  const at = mainAt(input.cwd, input.main);
  if (!at.ok) return at;
  const attached = attachedDocs(first.value.docs, first.value.criterion);
  // reason: the quote is checked as the close will check it, so the owner never approves a close that cannot be made (BR-2480)
  if (input.spurious !== undefined) {
    const found = quotedIn(input.cwd, at.value, input.main, first.value.id, attached, input.spurious);
    if (!found.ok) return found;
  }
  const stamp = docsAt(input.cwd, at.value, attached);
  // reason: the pending check and the new question are one transaction, so two asks at once leave one question (#224)
  return db.db
    .transaction((): Result<{ question: number; text: string; target: Target }> => {
      const row = findingRow(db, input.id);
      if (!row.ok) return row;
      const f = row.value;
      if (f.question !== null) {
        if (awaiting(db, f.question)) return err("conflict", `#${f.id} already waits on owner question #${f.question} (canon human pending)`);
      }
      const ids = JSON.parse(f.ids) as string[];
      const text = `Close review finding #${f.id} ([${f.criterion}] ${ids.length > 0 ? ids.join(", ") : "-"}: ${f.text}) as ${describe(t.value)}? ${reason}`;
      const q = ask(db, input.actor, `finding #${f.id}`, text, [APPROVE, REJECT]);
      db.db.query("INSERT INTO finding_asks(question, finding, how, target, docs_at) VALUES (?, ?, ?, ?, ?)").run(q, f.id, t.value.how, t.value.target, stamp);
      // reason: the finding now waits on the owner, so it is not owed until the answer comes (BR-2464)
      db.db.query("UPDATE review_findings SET question = ? WHERE id = ?").run(q, f.id);
      return ok({ question: q, text, target: t.value });
    })
    .immediate();
}

/** The evidence a close gives beyond BR-2453's commit or quote (BR-2478). */
export interface Evidence {
  readonly owner?: string;
  readonly covers?: string;
}

interface Answered {
  id: number;
  question: string;
  answer: string | null;
  relayed: string | null;
  witness: string | null;
}

/** The owner's approval of this close (BR-2480): the answer to its own `canon finding ask`, or an older answer the close quotes. */
function ownerApproval(db: CoordDb, finding: number, t: Target, ev: Evidence, stamp: string): Result<Record<string, unknown>> {
  const raw = (ev.owner ?? "").replace(/^#/, "");
  const qn = Number(raw);
  if (!/^\d+$/.test(raw) || qn <= 0) return err("invalid", `--owner takes an owner question's number, got ${JSON.stringify(ev.owner)}`);
  const q = db.db.query<Answered, [number]>("SELECT id, question, answer, relayed, witness FROM questions WHERE id = ?").get(qn);
  if (!q) return err("not_found", `--owner #${qn}: no such question`);
  if (q.answer === null) return err("refused", `--owner #${qn}: not answered yet (canon human pending)`);
  // reason: a relay the question tool contradicts, or that its records never saw asked, is not the owner's word (BR-2276)
  if (q.witness === "differs" || q.witness === "unasked") return err("refused", `--owner #${qn}: the relayed answer is not backed by the question tool's record (${q.witness})`);
  const asked = db.db.query<{ finding: number; how: string; target: string; docs_at: string | null }, [number]>("SELECT finding, how, target, docs_at FROM finding_asks WHERE question = ?").get(qn);
  if (asked) {
    if (asked.finding !== finding) return err("refused", `--owner #${qn} asked about finding #${asked.finding}, not #${finding}`);
    if (asked.how !== t.how || asked.target !== t.target) return err("refused", `--owner #${qn} approved closing #${finding} ${describe({ how: asked.how as Target["how"], target: asked.target })}, not ${describe(t)}; ask again for this close`);
    if (q.answer !== APPROVE) return err("refused", `--owner #${qn}: the owner did not approve (answer: ${JSON.stringify(q.answer)})`);
    // reason: a spurious close is judged against the documents' text; once one changed, the approval was of other text (#226)
    if (t.how === "spurious" && asked.docs_at !== stamp) return err("refused", `--owner #${qn}: a document #${finding} names changed on main since the owner approved; ask again for this close`);
    return ok({ owner: qn });
  }
  // reason: an older answer that already decides this is reused, not asked again; the close quotes the words that decide it (D-118)
  const covers = squash(ev.covers ?? "");
  if ([...covers].length < 8) return err("refused", `--owner #${qn} was not asked for this close: add --covers "<at least 8 characters of its question or answer that decide it>"`);
  const said = squash(`${q.question}\n${q.answer}\n${q.relayed ?? ""}`);
  if (!said.includes(covers)) return err("refused", `--owner #${qn}: the --covers quote is not in its question or answer`);
  return ok({ owner: qn, covers });
}

/**
 * BR-2478: whether this caller may close finding `id` this way; the evidence to record when it may. It only reads the
 * database, so the caller runs it inside the write transaction (#224); `stamp` is the documents' versions on main, read before.
 */
export function tierGate(db: CoordDb, input: { readonly id: number; readonly caller: Caller; readonly target: Target; readonly evidence: Evidence; readonly stamp: string }): Result<Record<string, unknown>> {
  const row = db.db.query<{ tier: string | null }, [number]>("SELECT tier FROM review_findings WHERE id = ?").get(input.id);
  if (input.caller.human) return ok({ tier: row?.tier ?? null, by: "owner" });
  const tier = (row?.tier ?? null) as Tier | null;
  const n = input.id;
  if (tier === null) return err("refused", `#${n} has no tier yet: canon finding tier ${n} A|B|C --reason "<why>" first (A the session settles it, B with another session's support, C the owner's)`);
  if (input.evidence.owner !== undefined) {
    const o = ownerApproval(db, n, input.target, input.evidence, input.stamp);
    return o.ok ? ok({ tier, ...o.value }) : o;
  }
  if (tier === "C") return err("refused", `#${n} is tier C: the owner decides; canon finding ask ${n} ${input.target.how === "fixed" ? `--fixed ${input.target.target.slice(0, 9)}` : "--spurious \"<quote>\""} --reason "<what this does>", ask it in the conversation, then close with --owner <question>`);
  // reason: calling a finding spurious is the session overruling its reviewer; it needs a second opinion at least (#216)
  if (tier === "A" && input.target.how === "spurious") return err("refused", `#${n} is tier A: a spurious close needs another session's support; raise it with canon finding tier ${n} B --reason "<why>"`);
  if (tier === "A") return ok({ tier });
  // reason: a subagent or a delegated worker closing on advice would be its own session's say-so; the owner's --owner still works for it (#225)
  if (input.caller.notIndependent) return err("refused", `#${n} is tier B and this is ${input.caller.notIndependent}: its session closes it on another session's support, or the owner approves (canon finding ask ${n}, then --owner <question>)`);
  const advice = db.db
    .query<{ session: string; verdict: string; docs_at: string | null }, [number, string, string]>("SELECT session, verdict, docs_at FROM finding_advice WHERE finding = ? AND how = ? AND target = ? ORDER BY id")
    .all(n, input.target.how, input.target.target);
  const latest = new Map<string, string>();
  // reason: a spurious close's advice judged the documents' text then; advice given before one of them changed no longer counts (#226)
  for (const a of advice) if (input.target.how === "fixed" || a.docs_at === input.stamp) latest.set(a.session, a.verdict);
  latest.delete(input.caller.key);
  const against = [...latest].filter(([, v]) => v === "oppose").map(([s]) => s);
  if (against.length > 0) return err("refused", `#${n} is tier B and ${against.join(", ")} opposes closing it ${describe(input.target)}; settle that with them or ask the owner (canon finding ask)`);
  // reason: support from the closer's own session (its parent or a sibling subagent) is not another session's (#225)
  const support = [...latest].filter(([s, v]) => v === "support" && rootOf(s) !== input.caller.root).map(([s]) => s);
  if (support.length === 0) return err("refused", `#${n} is tier B: another session must support closing it ${describe(input.target)}: there, canon finding advise ${n} --support ${input.target.how === "fixed" ? `--fixed ${input.target.target.slice(0, 9)}` : "--spurious \"<quote>\""}  --reason "<why>"; with no other session available, ask the owner instead (canon finding ask ${n}, then --owner <question>)`);
  return ok({ tier, advisors: support });
}

/** Open findings by tier, for `canon brief` and `canon context` (BR-2477): `A 1, B 2, C 0, untriaged 3`. */
export function tierCounts(tiers: readonly (string | null)[]): string {
  const c = (t: string | null) => tiers.filter((x) => x === t).length;
  return `A ${c("A")}, B ${c("B")}, C ${c("C")}, untriaged ${c(null)}`;
}
