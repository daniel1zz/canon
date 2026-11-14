import { agentSession } from "../../../kernel/agent.ts";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { CoordDb } from "../../../work/db.ts";
import { ask } from "../../../work/humans/questions.ts";

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
  /** Why this caller cannot advise, when it cannot: a subagent, a delegated worker, or a session canon cannot name. */
  readonly notIndependent?: string;
}

export function callerOf(env: Record<string, string | undefined>, actor: string): Caller {
  const s = agentSession(env);
  if (!s) return { key: actor, human: actor.startsWith("human:") };
  const key = `${s.runtime}:${s.id}${s.child ? `:${s.child}` : ""}`;
  // reason: a subagent or a worker its session launched answers to that session; its support is not a second opinion (D-118)
  const notIndependent = s.child ? "a subagent" : env["CLAUDE_DELEGATE_CHILD"] === "1" ? "a delegated worker" : s.id === "unknown" ? "a session canon cannot name (no CLAUDE_CODE_SESSION_ID)" : undefined;
  return { key, human: false, ...(notIndependent ? { notIndependent } : {}) };
}

interface FindingRow {
  id: number;
  tier: string | null;
  closed_at: string | null;
  question: number | null;
  criterion: string;
  ids: string;
  text: string;
}

function findingNumber(raw: string): Result<number> {
  const s = raw.replace(/^#/, "");
  const n = Number(s);
  return /^\d+$/.test(s) && Number.isSafeInteger(n) && n > 0 ? ok(n) : err("invalid", `the finding number must be a positive whole number, got ${JSON.stringify(raw)}`);
}

function openRow(db: CoordDb, raw: string): Result<FindingRow> {
  const n = findingNumber(raw);
  if (!n.ok) return n;
  const row = db.db.query<FindingRow, [number]>("SELECT id, tier, closed_at, question, criterion, ids, text FROM review_findings WHERE id = ?").get(n.value);
  if (!row) return err("not_found", `review finding #${n.value} does not exist`);
  if (row.closed_at !== null) return err("conflict", `review finding #${n.value} is already closed`);
  return ok(row);
}

/** `canon finding tier` (BR-2477): sets or raises a finding's tier with a reason; only a person outside an agent session lowers one. */
export function setTier(db: CoordDb, input: { readonly actor: string; readonly caller: Caller; readonly id: string; readonly tier: string; readonly reason: string }): Result<{ id: number; from: Tier | null; to: Tier }> {
  const to = input.tier.toUpperCase();
  if (!(TIERS as readonly string[]).includes(to)) return err("invalid", `the tier is A, B or C, got ${JSON.stringify(input.tier)}`);
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say why the finding is this tier");
  const row = openRow(db, input.id);
  if (!row.ok) return row;
  const from = row.value.tier as Tier | null;
  if (from !== null && RANK[to as Tier] < RANK[from] && !input.caller.human) return err("refused", `#${row.value.id} is tier ${from}: a session only raises a tier; the owner lowers one (from a terminal outside an agent session)`);
  db.db.transaction(() => {
    db.db.query("UPDATE review_findings SET tier = ?, tier_reason = ? WHERE id = ?").run(to, reason, row.value.id);
    db.event(input.actor, "finding.tier", null, { finding: row.value.id, from, to, reason });
  }).immediate();
  return ok({ id: row.value.id, from, to: to as Tier });
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
export function advise(db: CoordDb, input: { readonly cwd: string; readonly actor: string; readonly caller: Caller; readonly id: string; readonly verdict: "support" | "oppose"; readonly fixed?: string; readonly spurious?: string; readonly reason: string }): Result<{ id: number; target: Target }> {
  if (input.caller.notIndependent) return err("refused", `canon finding advise: this is ${input.caller.notIndependent}; advice comes from a session of its own`);
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say why this close holds or does not");
  const row = openRow(db, input.id);
  if (!row.ok) return row;
  const t = targetOf(input.cwd, input.fixed, input.spurious);
  if (!t.ok) return t;
  db.db.transaction(() => {
    db.db.query("INSERT INTO finding_advice(finding, session, actor, verdict, how, target, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.value.id, input.caller.key, input.actor, input.verdict, t.value.how, t.value.target, reason, new Date().toISOString());
    db.event(input.actor, "finding.advise", null, { finding: row.value.id, session: input.caller.key, verdict: input.verdict, how: t.value.how, target: t.value.target, reason });
  }).immediate();
  return ok({ id: row.value.id, target: t.value });
}

export const APPROVE = "approve: close it this way";
export const REJECT = "reject: do not close it this way";

/** `canon finding ask` (BR-2480): records the owner question that approves one way of closing a finding. */
export function askOwner(db: CoordDb, input: { readonly cwd: string; readonly actor: string; readonly id: string; readonly fixed?: string; readonly spurious?: string; readonly reason: string }): Result<{ question: number; text: string; target: Target }> {
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say what the close does, for the owner to judge");
  const row = openRow(db, input.id);
  if (!row.ok) return row;
  const f = row.value;
  if (f.question !== null) {
    const q = db.db.query<{ answer: string | null }, [number]>("SELECT answer FROM questions WHERE id = ?").get(f.question);
    if (q && q.answer === null) return err("conflict", `#${f.id} already waits on owner question #${f.question} (canon human pending)`);
  }
  const t = targetOf(input.cwd, input.fixed, input.spurious);
  if (!t.ok) return t;
  const ids = JSON.parse(f.ids) as string[];
  const text = `Close review finding #${f.id} ([${f.criterion}] ${ids.length > 0 ? ids.join(", ") : "-"}: ${f.text}) as ${describe(t.value)}? ${reason}`;
  const question = db.db.transaction((): number => {
    const q = ask(db, input.actor, `finding #${f.id}`, text, [APPROVE, REJECT]);
    db.db.query("INSERT INTO finding_asks(question, finding, how, target) VALUES (?, ?, ?, ?)").run(q, f.id, t.value.how, t.value.target);
    // reason: the finding now waits on the owner, so it is not owed until the answer comes (BR-2464)
    db.db.query("UPDATE review_findings SET question = ? WHERE id = ?").run(q, f.id);
    return q;
  }).immediate();
  return ok({ question, text, target: t.value });
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
function ownerApproval(db: CoordDb, finding: number, t: Target, ev: Evidence): Result<Record<string, unknown>> {
  const raw = (ev.owner ?? "").replace(/^#/, "");
  const qn = Number(raw);
  if (!/^\d+$/.test(raw) || qn <= 0) return err("invalid", `--owner takes an owner question's number, got ${JSON.stringify(ev.owner)}`);
  const q = db.db.query<Answered, [number]>("SELECT id, question, answer, relayed, witness FROM questions WHERE id = ?").get(qn);
  if (!q) return err("not_found", `--owner #${qn}: no such question`);
  if (q.answer === null) return err("refused", `--owner #${qn}: not answered yet (canon human pending)`);
  // reason: a relay the question tool contradicts, or that its records never saw asked, is not the owner's word (BR-2276)
  if (q.witness === "differs" || q.witness === "unasked") return err("refused", `--owner #${qn}: the relayed answer is not backed by the question tool's record (${q.witness})`);
  const asked = db.db.query<{ finding: number; how: string; target: string }, [number]>("SELECT finding, how, target FROM finding_asks WHERE question = ?").get(qn);
  if (asked) {
    if (asked.finding !== finding) return err("refused", `--owner #${qn} asked about finding #${asked.finding}, not #${finding}`);
    if (asked.how !== t.how || asked.target !== t.target) return err("refused", `--owner #${qn} approved closing #${finding} ${describe({ how: asked.how as Target["how"], target: asked.target })}, not ${describe(t)}; ask again for this close`);
    if (q.answer !== APPROVE) return err("refused", `--owner #${qn}: the owner did not approve (answer: ${JSON.stringify(q.answer)})`);
    return ok({ owner: qn });
  }
  // reason: an older answer that already decides this is reused, not asked again; the close quotes the words that decide it (D-118)
  const covers = squash(ev.covers ?? "");
  if ([...covers].length < 8) return err("refused", `--owner #${qn} was not asked for this close: add --covers "<at least 8 characters of its question or answer that decide it>"`);
  const said = squash(`${q.question}\n${q.answer}\n${q.relayed ?? ""}`);
  if (!said.includes(covers)) return err("refused", `--owner #${qn}: the --covers quote is not in its question or answer`);
  return ok({ owner: qn, covers });
}

/** BR-2478: whether this caller may close finding `id` this way; the evidence to record when it may. */
export function tierGate(db: CoordDb, input: { readonly id: number; readonly caller: Caller; readonly target: Target; readonly evidence: Evidence }): Result<Record<string, unknown>> {
  const row = db.db.query<{ tier: string | null }, [number]>("SELECT tier FROM review_findings WHERE id = ?").get(input.id);
  if (input.caller.human) return ok({ tier: row?.tier ?? null, by: "owner" });
  const tier = (row?.tier ?? null) as Tier | null;
  const n = input.id;
  if (tier === null) return err("refused", `#${n} has no tier yet: canon finding tier ${n} A|B|C --reason "<why>" first (A the session settles it, B with another session's support, C the owner's)`);
  if (input.evidence.owner !== undefined) {
    const o = ownerApproval(db, n, input.target, input.evidence);
    return o.ok ? ok({ tier, ...o.value }) : o;
  }
  if (tier === "C") return err("refused", `#${n} is tier C: the owner decides; canon finding ask ${n} ${input.target.how === "fixed" ? `--fixed ${input.target.target.slice(0, 9)}` : "--spurious \"<quote>\""} --reason "<what this does>", ask it in the conversation, then close with --owner <question>`);
  // reason: calling a finding spurious is the session overruling its reviewer; it needs a second opinion at least (#216)
  if (tier === "A" && input.target.how === "spurious") return err("refused", `#${n} is tier A: a spurious close needs another session's support; raise it with canon finding tier ${n} B --reason "<why>"`);
  if (tier === "A") return ok({ tier });
  const advice = db.db
    .query<{ session: string; verdict: string }, [number, string, string]>("SELECT session, verdict FROM finding_advice WHERE finding = ? AND how = ? AND target = ? ORDER BY id")
    .all(n, input.target.how, input.target.target);
  const latest = new Map<string, string>();
  for (const a of advice) latest.set(a.session, a.verdict);
  latest.delete(input.caller.key);
  const against = [...latest].filter(([, v]) => v === "oppose").map(([s]) => s);
  if (against.length > 0) return err("refused", `#${n} is tier B and ${against.join(", ")} opposes closing it ${describe(input.target)}; settle that with them or ask the owner (canon finding ask)`);
  const support = [...latest].filter(([, v]) => v === "support").map(([s]) => s);
  if (support.length === 0) return err("refused", `#${n} is tier B: another session must support closing it ${describe(input.target)}: there, canon finding advise ${n} --support ${input.target.how === "fixed" ? `--fixed ${input.target.target.slice(0, 9)}` : "--spurious \"<quote>\""}  --reason "<why>"; with no other session available, ask the owner instead (canon finding ask ${n}, then --owner <question>)`);
  return ok({ tier, advisors: support });
}

/** Open findings by tier, for `canon brief` and `canon context` (BR-2477): `A 1, B 2, C 0, untriaged 3`. */
export function tierCounts(tiers: readonly (string | null)[]): string {
  const c = (t: string | null) => tiers.filter((x) => x === t).length;
  return `A ${c("A")}, B ${c("B")}, C ${c("C")}, untriaged ${c(null)}`;
}
