import { createHash } from "node:crypto";
import { parse } from "yaml";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../../work/db.ts";
import type { Corpus, Doc } from "../documents/model.ts";
import { queryKeys } from "./config-keys.ts";
import { RELATED_LIMIT, reasons, relatedIndex, relatedLines, relatedTo, type Related, type RelatedIndex } from "./related.ts";

/**
 * The optional pick of related documents (BR-2443, BR-2444, BR-2445, D-90): a project-configured command, read from main,
 * gets document A's text and the fused ranking's top 50 and answers which of them are related, most likely first. Run
 * only by `canon context <id>` and `canon work review` (and acceptance, through `relatedSections`), never by the edit
 * hook, `canon check` or a landing: it is a model call, too slow and costly for every edit.
 */

/** How many of the fused ranking the command chooses from (D-90: the top 50 held 82.5% of the related pairs). */
export const PICK_POOL = 50;
/** An excerpt of each candidate in the prompt, in characters (D-90 measured with about 220). */
export const EXCERPT_CHARS = 220;
const REASON_CHARS = 120;
const KEY = queryKeys.relatedPickCommand.key;

export interface PickSettings {
  readonly command: string | undefined;
  readonly timeoutMs: number;
}

/** The pick settings in `canon/config.yaml` at `rev` (main), the way BR-2074 reads the review settings: absent file or key is the default. */
export function pickSettingsOn(root: string, rev: string): Result<PickSettings> {
  const text = git(root, "show", `${rev}:canon/config.yaml`);
  let raw: Record<string, unknown> = {};
  if (text.ok) {
    try {
      const parsed = parse(text.value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch (e) {
      return err("invalid", `not valid YAML: ${(e as Error).message}`);
    }
  }
  const ctx = { root, raw };
  const command = raw[KEY] === undefined ? ok(queryKeys.relatedPickCommand.default) : queryKeys.relatedPickCommand.read(raw[KEY], ctx);
  if (!command.ok) return command;
  const t = queryKeys.relatedPickTimeoutMs;
  const timeoutMs = raw[t.key] === undefined ? ok(t.default) : t.read(raw[t.key], ctx);
  if (!timeoutMs.ok) return timeoutMs;
  return ok({ command: command.value, timeoutMs: timeoutMs.value });
}

/** A candidate's text in the prompt: title and body without headings, whitespace collapsed, cut to EXCERPT_CHARS. */
export function excerpt(doc: Doc): string {
  const text = doc.body.replace(/^\s*#.*$/gm, "").replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

/** What the command reads on stdin (BR-2443): the task, A's whole text, then each candidate as `- <id> <title>: <excerpt>`. */
export function pickPrompt(doc: Doc, candidates: readonly Related[]): string {
  return [
    `You pick which of the candidate documents below are related to document ${doc.id}: a rule or decision ${doc.id} could contradict, restate, depend on, or must stay consistent with (the same state, input, timing, field or event, even in other words).`,
    `Answer with only a JSON list, most likely related first, leaving out the unrelated ones: [{"id":"<candidate id>","reason":"<one line: the sentence of ${doc.id} most likely to conflict with it, and why>"}]. [] means none is related. Use only the candidate ids listed.`,
    "",
    `# Document ${doc.id}: ${doc.title}`,
    "",
    doc.body.trim(),
    "",
    `# Candidates (${candidates.length})`,
    "",
    ...candidates.map((c) => `- ${c.doc.id} ${c.doc.title}: ${excerpt(c.doc)}`),
    "",
  ].join("\n");
}

/** One picked document: its id and the command's one-line reason, when it gave one. */
export interface Pick {
  readonly id: string;
  readonly reason?: string;
}

/** A valid answer: the picks among the candidates in the command's order, and the ids it gave that were not candidates. */
export interface PickAnswer {
  readonly picks: readonly Pick[];
  readonly dropped: readonly string[];
}

/**
 * The command's stdout as an answer (BR-2443, BR-2445): the whole output, or else the text from its first `[` to its
 * last `]`, must be a JSON list whose items are an id string or an object with a string `id` and an optional string
 * `reason`. Ids not among the candidates are dropped and returned; a repeated id counts once.
 */
export function parsePicks(out: string, candidates: ReadonlySet<string>): Result<PickAnswer> {
  const trimmed = out.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const from = trimmed.indexOf("[");
    const to = trimmed.lastIndexOf("]");
    if (from < 0 || to < from) return err("invalid", `it printed no JSON list: ${JSON.stringify(trimmed.slice(0, 200))}`);
    try {
      value = JSON.parse(trimmed.slice(from, to + 1));
    } catch (e) {
      return err("invalid", `its JSON list does not parse: ${(e as Error).message}`);
    }
  }
  if (!Array.isArray(value)) return err("invalid", `it printed JSON that is not a list: ${JSON.stringify(trimmed.slice(0, 200))}`);
  const picks: Pick[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of value.entries()) {
    const o = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as { id?: unknown; reason?: unknown }) : undefined;
    const id = typeof item === "string" ? item : o && typeof o.id === "string" ? o.id : undefined;
    if (id === undefined) return err("invalid", `item ${i + 1} of its list is neither an id nor {"id":"…","reason":"…"}: ${JSON.stringify(item).slice(0, 120)}`);
    if (o && o.reason !== undefined && typeof o.reason !== "string") return err("invalid", `item ${i + 1} of its list has a reason that is not a string`);
    const key = id.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!candidates.has(key)) {
      dropped.push(key);
      continue;
    }
    const reason = typeof o?.reason === "string" ? oneLine(o.reason) : "";
    picks.push(reason ? { id: key, reason } : { id: key });
  }
  return ok({ picks, dropped });
}

const oneLine = (s: string): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line;
};

/**
 * The cache key of one pick (BR-2444): SHA-256 over the command and the whole prompt, which holds A's text and every
 * candidate as shown (id, title, excerpt) in ranking order. A change to anything the command reads makes a new key.
 */
export function pickKey(command: string, prompt: string): string {
  const h = createHash("sha256");
  // reason: length-prefixed parts, so no two different (command, prompt) give the same byte stream (as BR-2361's key)
  for (const part of [command, prompt]) h.update(`${Buffer.byteLength(part)}:`).update(part).update("\n");
  return h.digest("hex");
}

// reason: the table belongs to this module, so it is created where it is used; CREATE ... IF NOT EXISTS is safe to race (BR-2078)
const SCHEMA = `CREATE TABLE IF NOT EXISTS related_picks (
  key    TEXT PRIMARY KEY,           -- pickKey: the command and the prompt it read (BR-2444)
  doc    TEXT NOT NULL,              -- document A's id
  answer TEXT NOT NULL,              -- the valid answer as JSON: {picks:[{id,reason?}], dropped:[id]}
  at     TEXT NOT NULL
)`;

function cached(db: CoordDb, key: string): PickAnswer | undefined {
  db.db.exec(SCHEMA);
  const row = db.db.query<{ answer: string }, [string]>("SELECT answer FROM related_picks WHERE key = ?").get(key);
  return row ? (JSON.parse(row.answer) as PickAnswer) : undefined;
}

function remember(db: CoordDb, key: string, doc: string, answer: PickAnswer): void {
  db.db.exec(SCHEMA);
  db.db.query("INSERT OR REPLACE INTO related_picks(key, doc, answer, at) VALUES (?, ?, ?, ?)").run(key, doc, JSON.stringify(answer), new Date().toISOString());
}

/** Runs the command with `prompt` on stdin in `cwd`; its stdout, or why it failed (exit code, time limit). */
async function runPick(command: string, cwd: string, prompt: string, timeoutMs: number): Promise<Result<string>> {
  // reason: its own process group, so the time limit stops the command's children too (a model CLI under sh), as BR-2296 does for the review
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // reason: the group is already gone; nothing is left to stop
    }
  }, timeoutMs);
  let out: string, errText: string, code: number;
  try {
    [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return err("io", `it did not finish within ${timeoutMs / 1000} second(s) (related_pick_timeout_seconds) and was stopped`);
  if (code !== 0) {
    const said = errText.trim() ? errText.trim().slice(0, 200) : out.trim() ? out.trim().slice(-200) : "no output";
    return err("io", `it exited ${code}: ${said.replace(/\s+/g, " ")}`);
  }
  return ok(out);
}

/** What `relatedSections` needs: the checkout to run in, the database to cache in, main's commit to read the settings from. */
export interface PickContext {
  readonly root: string;
  readonly db: CoordDb;
  readonly actor: string;
  /** The commit of main whose canon/config.yaml names the command (BR-2443), or why it cannot be found. */
  readonly main: string | Result<never>;
  readonly corpus: Corpus;
  readonly index?: RelatedIndex;
}

/** The fused ranking's top 10 for `doc`, with the command's picks first when it is configured and answered (BR-2443, BR-2445). */
async function sectionFor(c: PickContext, index: RelatedIndex, settings: Result<PickSettings>, doc: Doc): Promise<string[]> {
  const pool = relatedTo(c.corpus, doc, PICK_POOL, index);
  if (pool.length === 0) return [];
  const fused = pool.slice(0, RELATED_LIMIT);
  // reason: never quietly the fused list when a pick was meant: the line says why and that nothing was picked (BR-2445, D-90)
  const fallback = (why: string) => [`${KEY}: ${why}; the list below is the fused ranking, nothing was picked`, ...render(doc, [], fused)];
  if (!settings.ok) return fallback(`canon/config.yaml on main cannot be read: ${settings.error.message}`);
  const { command, timeoutMs } = settings.value;
  if (command === undefined) return render(doc, [], fused);
  const prompt = pickPrompt(doc, pool);
  const key = pickKey(command, prompt);
  let answer = cached(c.db, key);
  if (answer === undefined) {
    const started = Date.now();
    const run = await runPick(command, c.root, prompt, timeoutMs);
    const parsed = run.ok ? parsePicks(run.value, new Set(pool.map((r) => r.doc.id))) : run;
    c.db.event(c.actor, "related.pick", doc.id, { key, candidates: pool.length, ms: Date.now() - started, ...(parsed.ok ? { picked: parsed.value.picks.map((p) => p.id), dropped: parsed.value.dropped } : { error: parsed.error.message }) });
    if (!parsed.ok) return fallback(parsed.error.message);
    remember(c.db, key, doc.id, parsed.value);
    answer = parsed.value;
  }
  const dropped = answer.dropped.length ? `dropped ${answer.dropped.length} id(s) not among the ${pool.length} candidates: ${answer.dropped.join(", ")}` : "";
  if (answer.picks.length === 0) return fallback(dropped ? `picked no candidate (${dropped})` : `picked none of the ${pool.length} candidates`);
  const byId = new Map(pool.map((r) => [r.doc.id, r]));
  const picked = answer.picks.slice(0, RELATED_LIMIT).map((p) => ({ related: byId.get(p.id)!, reason: p.reason }));
  const shown = new Set(picked.map((p) => p.related.doc.id));
  const rest = fused.filter((r) => !shown.has(r.doc.id));
  return [...(dropped ? [`${KEY}: ${dropped}`] : []), ...render(doc, picked, rest)];
}

/** The section: the picked ones first, marked with their reason, then the rest of the fused top 10 as BR-2387 writes them. */
function render(doc: Doc, picked: readonly { related: Related; reason: string | undefined }[], rest: readonly Related[]): string[] {
  if (picked.length === 0) return relatedLines(doc, rest);
  const head = `Related to ${doc.id} (the first ${picked.length} picked by ${KEY} from the fused top ${PICK_POOL}, then references both ways, shared text and names; check they do not contradict it):`;
  const entry = (r: Related, why: string) => [`  ${r.doc.id} ${r.doc.title}  (${why})`, ...(r.sentence ? [`      ${r.sentence}`] : [])];
  return [
    head,
    ...picked.flatMap((p) => entry(p.related, [p.reason ? `picked: ${p.reason}` : "picked", reasons(p.related, doc.id)].filter(Boolean).join("; "))),
    ...rest.flatMap((r) => entry(r, reasons(r, doc.id))),
  ];
}

/**
 * The related-documents sections of `docs` for `canon context`, `canon work review` and acceptance (BR-2387, BR-2443):
 * the fused ranking, with the picks of `related_pick_command` on main first when it is set. Empty for a document with
 * nothing related. Never throws for a failing command: the section says why (BR-2445).
 */
export async function relatedSections(c: PickContext, docs: readonly Doc[]): Promise<string[]> {
  if (docs.length === 0) return [];
  const index = c.index ?? relatedIndex(c.corpus);
  const settings = typeof c.main === "string" ? pickSettingsOn(c.root, c.main) : c.main;
  const out: string[] = [];
  for (const doc of docs) out.push(...(await sectionFor(c, index, settings, doc)));
  return out;
}
