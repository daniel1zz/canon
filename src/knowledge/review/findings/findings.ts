import { createHash } from "node:crypto";
import type { CoordDb } from "../../../work/db.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import { DUPLICATE_CRITERIA, RULE_CRITERIA } from "../review.ts";

/**
 * Open review findings (D-89, D-97): a finding that names a blocking criterion has an identity (BR-2433), is
 * recorded once per identity on every document it names (BR-2434) and stays open until something closes it
 * explicitly: a document it names retired or superseded (BR-2435), a `spurious` verdict (BR-2438), or `canon finding
 * close` with the fixing commit or a quote (BR-2453, D-99). A later review that does not mention it changes nothing. Notes (criterion
 * `note`) are not recorded here: they stay open notes on the documents they name and are replaced on the next review
 * (BR-2145, D-21).
 */
export interface Finding {
  readonly criterion: string;
  readonly text: string;
}

const CRITERIA: readonly string[] = [...RULE_CRITERIA, ...DUPLICATE_CRITERIA];

/** A finding as the review events store it: `[criterion] text` for a blocking one, the bare text for a note (BR-2367). */
export function findingOf(stored: string): Finding {
  const m = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(stored);
  return m && CRITERIA.includes(m[1]!) ? { criterion: m[1]!, text: m[2]! } : { criterion: "note", text: stored };
}

const ID = /(?<![A-Za-z0-9-])(BR|D|R)-(\d+)(?![0-9])/g;
const QUOTE = /「([^」]*)」|“([^”]*)”|`([^`\n]*)`/g;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The rule, decision and release ids `text` names, anywhere in it, unique and sorted (BR-2433). */
export function namedIds(text: string): string[] {
  return [...new Set([...text.matchAll(ID)].map((m) => `${m[1]}-${m[2]}`))].sort();
}

/**
 * The quoted words a finding points at (BR-2433): every span in 「」, “” or single backticks, whitespace squashed,
 * without the spans that are empty or hold only ids (`BR-1` names a document, it quotes nothing); unique and sorted.
 */
export function quotedSpans(text: string): string[] {
  const spans = [...text.matchAll(QUOTE)].map((m) => squash(m[1] ?? m[2] ?? m[3] ?? ""));
  return [...new Set(spans.filter((s) => s.replace(ID, "").replace(/[\s,，、]/g, "") !== ""))].sort();
}

/** A finding's identity: criterion, sorted named ids, and the hash of its quoted words or, with none, of its whole squashed text (BR-2433). */
export function identityOf(f: Finding): string {
  const spans = quotedSpans(f.text);
  const pointed = spans.length > 0 ? spans.join("\n") : squash(f.text);
  const hash = createHash("sha256").update(pointed).digest("hex").slice(0, 16);
  return `${f.criterion} ${namedIds(f.text).join(",")} ${hash}`;
}

export interface OpenFinding {
  readonly id: number;
  readonly identity: string;
  readonly criterion: string;
  readonly ids: readonly string[];
  readonly docs: readonly string[];
  readonly text: string;
  readonly change: string | null;
  readonly event: number;
  readonly sha: string | null;
  readonly openedAt: string;
}

interface Row {
  id: number;
  identity: string;
  criterion: string;
  ids: string;
  docs: string;
  text: string;
  change: string | null;
  event: number;
  sha: string | null;
  opened_at: string;
}

const fromRow = (r: Row): OpenFinding => ({ id: r.id, identity: r.identity, criterion: r.criterion, ids: JSON.parse(r.ids) as string[], docs: JSON.parse(r.docs) as string[], text: r.text, change: r.change, event: r.event, sha: r.sha, openedAt: r.opened_at });

export interface Recorded {
  /** The ids of the records this call opened. */
  readonly opened: readonly number[];
  /** The ids of the records already open under the same identity. */
  readonly existing: readonly number[];
}

/**
 * Records the blocking findings of one review (BR-2434): each one is attached to every document it names, or to every
 * reviewed document when it names none; a finding whose identity is already open adds its documents to that record and
 * opens nothing. Notes are skipped. `event` is the event that recorded the review, `sha` the commit it saw.
 */
export function recordFindings(db: CoordDb, input: { readonly findings: readonly Finding[]; readonly reviewed: readonly string[]; readonly change: string | null; readonly event: number; readonly sha: string | null }): Result<Recorded> {
  const blocking = input.findings.filter((f) => f.criterion !== "note");
  // reason: a finding with nowhere to be shown would be recorded and never seen; fail loud instead (BR-2434)
  const homeless = blocking.find((f) => namedIds(f.text).length === 0 && input.reviewed.length === 0);
  if (homeless) return err("invalid", `review finding names no document and no document was reviewed: ${homeless.text}`);
  const tx = db.db.transaction((): Result<Recorded> => {
    const opened: number[] = [];
    const existing: number[] = [];
    for (const f of blocking) {
      const identity = identityOf(f);
      const ids = namedIds(f.text);
      const docs = ids.length > 0 ? ids : [...new Set(input.reviewed)].sort();
      const open = db.db.query<{ id: number; docs: string }, [string]>("SELECT id, docs FROM review_findings WHERE identity = ? AND closed_at IS NULL").get(identity);
      if (open) {
        const merged = [...new Set([...(JSON.parse(open.docs) as string[]), ...docs])].sort();
        db.db.query("UPDATE review_findings SET docs = ? WHERE id = ?").run(JSON.stringify(merged), open.id);
        existing.push(open.id);
        continue;
      }
      const r = db.db
        .query("INSERT INTO review_findings(identity, criterion, ids, docs, text, change, event, sha, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(identity, f.criterion, JSON.stringify(ids), JSON.stringify(docs), f.text, input.change, input.event, input.sha, new Date().toISOString());
      opened.push(Number(r.lastInsertRowid));
    }
    return ok({ opened, existing });
  });
  return tx.immediate();
}

/** The open findings attached to any of `docs`, oldest first; every open finding when `docs` is omitted (BR-2436, BR-2437). */
export function openFindings(db: CoordDb, docs?: Iterable<string>): OpenFinding[] {
  const all = db.db.query<Row, []>("SELECT id, identity, criterion, ids, docs, text, change, event, sha, opened_at FROM review_findings WHERE closed_at IS NULL ORDER BY id").all().map(fromRow);
  if (docs === undefined) return all;
  const want = new Set(docs);
  return all.filter((f) => f.docs.some((d) => want.has(d)));
}

type How = "retired" | "spurious";

function close(db: CoordDb, id: number, how: How, event: number): void {
  db.db.query("UPDATE review_findings SET closed_at = ?, closed_how = ?, closed_event = ? WHERE id = ? AND closed_at IS NULL").run(new Date().toISOString(), how, event, id);
}

/**
 * Closes the open findings a landing made moot (BR-2435): one that names a document now retired or superseded, or,
 * naming none, one whose every attached document is. `event` is the landing's `land.ok`. Returns the closed ids.
 */
export function closeRetired(db: CoordDb, retired: ReadonlySet<string>, event: number): number[] {
  if (retired.size === 0) return [];
  const tx = db.db.transaction((): number[] => {
    const gone = openFindings(db).filter((f) => (f.ids.length > 0 ? f.ids.some((id) => retired.has(id)) : f.docs.every((d) => retired.has(d))));
    for (const f of gone) close(db, f.id, "retired", event);
    return gone.map((f) => f.id);
  });
  return tx.immediate();
}

/** Closes the open finding with this identity, judged spurious by the verdict `event` (BR-2438); the id it closed, if any. Runs inside the caller's transaction. */
export function closeSpurious(db: CoordDb, finding: Finding, event: number): number | undefined {
  const open = db.db.query<{ id: number }, [string]>("SELECT id FROM review_findings WHERE identity = ? AND closed_at IS NULL").get(identityOf(finding));
  if (open) close(db, open.id, "spurious", event);
  return open?.id;
}

/** One open finding as `canon context` and `canon brief` print it (BR-2436, BR-2437). */
export function renderFinding(f: OpenFinding, now: Date = new Date()): string {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(f.openedAt)) / 86_400_000));
  return `#${f.id} [${f.criterion}] ${f.ids.length > 0 ? f.ids.join(", ") : "-"}: ${f.text} (${f.change ? `${f.change}, ` : ""}opened ${f.openedAt.slice(0, 10)}, ${days} day${days === 1 ? "" : "s"} ago)`;
}

/** What `canon context` and `canon brief` say about open findings before listing them. */
export const FINDINGS_HINT = 'Settle each now: fixed, canon finding close <n> --fixed <commit> --reason "<why>"; does not hold, canon finding close <n> --spurious "<quote from a document it names>" --reason "<why>". Open until closed explicitly (also: a document it names retired or superseded, or canon verdict record); a later review that does not mention one does not close it.';

/** The line `canon brief` prints outside a change worktree: how many findings are open, on how many documents (BR-2437). */
export function findingsCount(db: CoordDb): string | undefined {
  const all = openFindings(db);
  if (all.length === 0) return undefined;
  const docs = new Set(all.flatMap((f) => f.docs));
  return `${all.length} open review finding(s) on ${docs.size} document(s): canon context <id> lists them`;
}
