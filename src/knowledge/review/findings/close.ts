import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { CoordDb } from "../../../work/db.ts";
import { mainAt, tierGate, type Caller } from "./tier.ts";
import { attachedDocs, docsAt, pathOn } from "./docs.ts";

export { pathOn };

/**
 * `canon finding close` (BR-2453, D-99): whoever settles a finding, the main agent or a person, closes it with the commit on
 * main that fixed one of its documents, or with a quote from one of them that shows it does not hold. Both are checked against
 * git, so a close is evidence, not a say-so.
 */
export type CloseHow = { readonly how: "fixed"; readonly commit: string } | { readonly how: "spurious"; readonly quote: string };

export interface CloseInput {
  /** The checkout to read git from. */
  readonly cwd: string;
  /** The main branch. */
  readonly main: string;
  readonly actor: string;
  readonly id: string;
  readonly fixed?: string;
  readonly spurious?: string;
  readonly reason: string;
  /** Who runs the close, from the host environment (D-118). */
  readonly caller: Caller;
  /** The owner question that approves this close (BR-2480). */
  readonly owner?: string;
  /** For an owner question not asked for this close: its words that decide it (BR-2480). */
  readonly covers?: string;
}

export interface Closed {
  readonly id: number;
  readonly how: "fixed" | "spurious";
  /** The full fixing commit, or the document the quote was found in. */
  readonly by: string;
  /** For an amend: the closing it replaced. */
  readonly from?: EarlierClosing;
}

/** The shortest quote accepted, as for decision sources (BR-2453). */
export const MIN_QUOTE = 8;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const ID = /^(BR|D|R)-\d+$/;

interface Row {
  id: number;
  docs: string;
  criterion: string;
  change: string | null;
  sha: string | null;
  closed_at: string | null;
  closed_how: string | null;
  closed_event: number | null;
}

/** Whether `commit` changed the file of any of `docs` (a document deleted by it counts by its path in the commit's parent). */
function touches(cwd: string, commit: string, docs: readonly string[]): Result<boolean> {
  const changed = git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", commit);
  if (!changed.ok) return changed;
  const paths = changed.value.split("\n").filter((p) => p !== "");
  return ok(docs.some((d) => (ID.test(d) ? paths.some((p) => new RegExp(`/${d}(-[^/]*)?\\.md$`).test(p)) : paths.includes(d))));
}

/** The checks of BR-2453 in its order, then the event and the close in one write transaction. */
export function closeFinding(db: CoordDb, input: CloseInput): Result<Closed> {
  return settle(db, input, "close");
}

/**
 * `canon finding amend` (BR-2483, #221): a closed finding's closing was wrong in kind or named the wrong commit; the same checks
 * as a close (BR-2453, then the tier's, BR-2478) and a new `finding.amend` event that becomes the closing, the earlier one kept.
 */
export function amendFinding(db: CoordDb, input: CloseInput): Result<Closed> {
  return settle(db, input, "amend");
}

function settle(db: CoordDb, input: CloseInput, mode: "close" | "amend"): Result<Closed> {
  const raw = input.id.replace(/^#/, "");
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) return err("invalid", `the finding number must be a positive whole number, got ${JSON.stringify(input.id)}`);
  if ((input.fixed === undefined) === (input.spurious === undefined)) return err("invalid", "give exactly one of --fixed <commit> and --spurious \"<quote>\"");
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", mode === "close" ? "--reason is required: say what fixed it or why it does not hold" : "--reason is required: say why the earlier closing was wrong");
  const look = (): Row | null => db.db.query<Row, [number]>("SELECT id, docs, criterion, change, sha, closed_at, closed_how, closed_event FROM review_findings WHERE id = ?").get(n);
  const row = look();
  if (!row) return err("not_found", `review finding #${n} does not exist`);
  let commit: string | undefined;
  if (input.fixed !== undefined) {
    const c = git(input.cwd, "rev-parse", "--verify", "--quiet", `${input.fixed}^{commit}`);
    if (!c.ok || c.value === "") return err("not_found", `--fixed ${input.fixed}: no such commit`);
    commit = c.value;
  }
  if (mode === "close" && row.closed_at !== null) return err("conflict", `review finding #${n} is already closed (${row.closed_how}, ${row.closed_at}); a wrong closing is corrected with canon finding amend ${n}`);
  if (mode === "amend" && row.closed_at === null) return err("conflict", `review finding #${n} is still open: close it with canon finding close ${n}`);
  // reason: one commit of main for every read below, so the checks and the documents' versions come from one tree (#226)
  const at = mainAt(input.cwd, input.main);
  if (!at.ok) return at;
  const main = at.value;
  // reason: an overview finding is attached to the documents it contradicts, but its fix or its disproof is in the overview itself (BR-2453)
  const docs = attachedDocs(row.docs, row.criterion);
  let by: string;
  if (commit !== undefined) {
    const onMain = git(input.cwd, "merge-base", "--is-ancestor", commit, main);
    if (!onMain.ok) return err("refused", `--fixed ${input.fixed}: the commit is not on ${input.main}; land the fix first`);
    // reason: the fix must come after the review that gave the finding, or any old commit touching the document would close it (BR-2453)
    if (row.sha !== null && git(input.cwd, "merge-base", "--is-ancestor", commit, row.sha).ok) return err("refused", `--fixed ${input.fixed}: the commit is already in ${row.sha.slice(0, 9)}, the commit the review saw when it gave #${n}; the fix must come after the finding`);
    const t = touches(input.cwd, commit, docs);
    if (!t.ok) return err("io", t.error.message);
    if (!t.value) return err("refused", `--fixed ${input.fixed}: the commit changes none of the documents #${n} is attached to (${docs.join(", ")})`);
    by = commit;
  } else {
    const quote = squash(input.spurious ?? "");
    if ([...quote].length < MIN_QUOTE) return err("refused", `--spurious: the quote must be at least ${MIN_QUOTE} characters of the document's own text, got ${JSON.stringify(quote)}`);
    const found = docs.find((d) => {
      const p = pathOn(input.cwd, main, d);
      const text = p ? git(input.cwd, "show", `${main}:${p}`) : undefined;
      return text?.ok === true && squash(text.value).includes(quote);
    });
    if (!found) return err("refused", `--spurious: the quote is in none of the documents #${n} is attached to on ${input.main}: ${docs.join(", ")}`);
    by = found;
  }
  const how = commit !== undefined ? "fixed" : "spurious";
  const stamp = docsAt(input.cwd, main, docs);
  const target = commit ?? squash(input.spurious ?? "");
  const write = db.db.transaction((): Result<Closed> => {
    // reason: another session may have closed or amended it since the read above; only the state seen now counts (BR-2453, BR-2483)
    const now = look();
    if (mode === "close" && now && now.closed_at !== null) return err("conflict", `review finding #${n} is already closed (${now.closed_how}, ${now.closed_at})`);
    const before = mode === "amend" && now ? earlierClosing(db, now) : undefined;
    // reason: an amend that says what the closing already says corrects nothing (BR-2483)
    if (before && before.how === how && before.target === target) return err("conflict", `review finding #${n} is already closed ${how === "fixed" ? `as fixed by ${target.slice(0, 9)}` : "as spurious with that quote"}`);
    // reason: the tier decides who may settle it, checked after BR-2453's own evidence so its refusals keep their order (BR-2478);
    // inside the write transaction, so a tier raised or an objection recorded meanwhile is seen (#222, #224)
    const gate = tierGate(db, { id: n, caller: input.caller, target: { how, target }, evidence: { ...(input.owner !== undefined ? { owner: input.owner } : {}), ...(input.covers !== undefined ? { covers: input.covers } : {}) }, stamp });
    if (!gate.ok) return gate;
    const detail = how === "fixed" ? { finding: n, how, commit, reason, ...gate.value } : { finding: n, how, quote: squash(input.spurious ?? ""), doc: by, reason, ...gate.value };
    if (mode === "amend") {
      // reason: the earlier closing stays in the event log; the row points at the latest one (BR-2483, #221)
      const event = db.event(input.actor, "finding.amend", row.change, { ...detail, from: before ?? null });
      db.db.query("UPDATE review_findings SET closed_how = ?, closed_event = ? WHERE id = ?").run(how, event, n);
      return ok({ id: n, how, by, ...(before ? { from: before } : {}) });
    }
    const event = db.event(input.actor, "finding.close", row.change, detail);
    db.db.query("UPDATE review_findings SET closed_at = ?, closed_how = ?, closed_event = ? WHERE id = ? AND closed_at IS NULL").run(new Date().toISOString(), how, event, n);
    return ok({ id: n, how, by });
  });
  return write.immediate();
}

/** What a finding's latest closing said: how, the commit or quote, the event and its reason (BR-2483). */
export interface EarlierClosing {
  readonly how: string;
  readonly target: string;
  readonly event: number | null;
  readonly reason: string | null;
}

/** The closing a closed finding has now, read from the event its row points at; a closing with no such event keeps how only. */
function earlierClosing(db: CoordDb, row: Row): EarlierClosing {
  const ev = row.closed_event === null ? null : db.db.query<{ detail: string | null }, [number]>("SELECT detail FROM events WHERE id = ?").get(row.closed_event);
  const d = ev?.detail ? (JSON.parse(ev.detail) as { commit?: string; quote?: string; reason?: string }) : {};
  return { how: row.closed_how ?? "", target: d.commit ?? d.quote ?? "", event: row.closed_event, reason: d.reason ?? null };
}

/** The line `canon finding close` and `canon finding amend` print (BR-2453, BR-2483). */
export function renderClosed(c: Closed): string {
  const now = c.how === "fixed" ? `fixed by ${c.by.slice(0, 9)}` : `spurious, quoted from ${c.by}`;
  return c.from ? `amended review finding #${c.id}: now ${now}; was ${c.from.how}${c.from.event !== null ? ` (event ${c.from.event})` : ""}` : `closed review finding #${c.id}: ${now}`;
}
