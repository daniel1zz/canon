import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import type { CoordDb } from "../../../work/db.ts";

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
}

export interface Closed {
  readonly id: number;
  readonly how: "fixed" | "spurious";
  /** The full fixing commit, or the document the quote was found in. */
  readonly by: string;
}

/** The shortest quote accepted, as for decision sources (BR-2453). */
export const MIN_QUOTE = 8;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const ID = /^(BR|D|R)-\d+$/;
/** The overview is not a document with an id, but an `overview` finding's fix usually lands there (BR-2453). */
const OVERVIEW = "canon/architecture.md";

interface Row {
  id: number;
  docs: string;
  criterion: string;
  change: string | null;
  sha: string | null;
  closed_at: string | null;
  closed_how: string | null;
}

/** The file of document `doc` on `main`: a rule, decision or release by its id, a standing instruction by its path. */
export function pathOn(cwd: string, main: string, doc: string): string | undefined {
  if (!ID.test(doc)) return doc;
  const names = git(cwd, "ls-tree", "-r", "--name-only", main, "canon/");
  if (!names.ok) return undefined;
  const re = new RegExp(`/${doc}(-[^/]*)?\\.md$`);
  return names.value.split("\n").find((p) => re.test(p));
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
  const raw = input.id.replace(/^#/, "");
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) return err("invalid", `the finding number must be a positive whole number, got ${JSON.stringify(input.id)}`);
  if ((input.fixed === undefined) === (input.spurious === undefined)) return err("invalid", "give exactly one of --fixed <commit> and --spurious \"<quote>\"");
  const reason = input.reason.trim();
  if (reason === "") return err("invalid", "--reason is required: say what fixed it or why it does not hold");
  const look = (): Row | null => db.db.query<Row, [number]>("SELECT id, docs, criterion, change, sha, closed_at, closed_how FROM review_findings WHERE id = ?").get(n);
  const row = look();
  if (!row) return err("not_found", `review finding #${n} does not exist`);
  let commit: string | undefined;
  if (input.fixed !== undefined) {
    const c = git(input.cwd, "rev-parse", "--verify", "--quiet", `${input.fixed}^{commit}`);
    if (!c.ok || c.value === "") return err("not_found", `--fixed ${input.fixed}: no such commit`);
    commit = c.value;
  }
  if (row.closed_at !== null) return err("conflict", `review finding #${n} is already closed (${row.closed_how}, ${row.closed_at})`);
  // reason: an overview finding is attached to the documents it contradicts, but its fix or its disproof is in the overview itself (BR-2453)
  const docs = [...(JSON.parse(row.docs) as string[]), ...(row.criterion === "overview" ? [OVERVIEW] : [])];
  let by: string;
  if (commit !== undefined) {
    const onMain = git(input.cwd, "merge-base", "--is-ancestor", commit, input.main);
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
      const p = pathOn(input.cwd, input.main, d);
      const text = p ? git(input.cwd, "show", `${input.main}:${p}`) : undefined;
      return text?.ok === true && squash(text.value).includes(quote);
    });
    if (!found) return err("refused", `--spurious: the quote is in none of the documents #${n} is attached to on ${input.main}: ${docs.join(", ")}`);
    by = found;
  }
  const how = commit !== undefined ? "fixed" : "spurious";
  const write = db.db.transaction((): Result<Closed> => {
    // reason: another session may have closed it since the read above; only one close is written (BR-2453)
    const now = look();
    if (now && now.closed_at !== null) return err("conflict", `review finding #${n} is already closed (${now.closed_how}, ${now.closed_at})`);
    const detail = how === "fixed" ? { finding: n, how, commit, reason } : { finding: n, how, quote: squash(input.spurious ?? ""), doc: by, reason };
    const event = db.event(input.actor, "finding.close", row.change, detail);
    db.db.query("UPDATE review_findings SET closed_at = ?, closed_how = ?, closed_event = ? WHERE id = ? AND closed_at IS NULL").run(new Date().toISOString(), how, event, n);
    return ok({ id: n, how, by });
  });
  return write.immediate();
}

/** The line `canon finding close` prints (BR-2453). */
export function renderClosed(c: Closed): string {
  return c.how === "fixed" ? `closed review finding #${c.id}: fixed by ${c.by.slice(0, 9)}` : `closed review finding #${c.id}: spurious, quoted from ${c.by}`;
}
