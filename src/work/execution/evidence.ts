import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config/config.ts";
import { git } from "../../kernel/git.ts";
import { behaviourHash, behaviourParts } from "../../knowledge/documents/behaviour.ts";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import type { Change, Corpus, PassRecord, Rule } from "../../knowledge/documents/model.ts";
import { section } from "../../knowledge/documents/templates.ts";
import { idsIn } from "../../knowledge/documents/types.ts";
import { testTitles } from "../../knowledge/check/test-titles.ts";
import { testFilesFor } from "../../knowledge/check/tests.ts";
import type { CoordDb } from "../db.ts";

/**
 * What one execution proves (D-32): for the change being closed, the pass record of each rule it executes and
 * the rules that lack evidence (BR-2241), plus the migration records of a project's first close (BR-2245).
 * The same computation runs twice: before the close commit, on the change's branch, to write the records
 * (BR-2242), and at the landing on the tree that becomes main, to check them (BR-2242, BR-2244).
 */

/** A range of commits one landing of the change brought: `base..head`. */
export interface Range {
  readonly base: string;
  readonly head: string;
}

export interface PlanInput {
  /** Checkout at `head`: the worktree before the close commit, or the landing tree. */
  readonly root: string;
  readonly head: string;
  readonly corpus: Corpus;
  readonly config: Config;
  readonly change: Change;
  /** Every landing of this change: earlier ones from the event table and the current one. */
  readonly ranges: readonly Range[];
  /** Whether main holds any pass record of a done change; when not, this close migrates (BR-2245). */
  readonly mainHasPasses: boolean;
  /** Rules evaluated even when another done change already has a record of their hash: the ones the close commit recorded. */
  readonly recorded?: ReadonlySet<string>;
}

export interface Missing {
  readonly id: string;
  readonly untested: boolean;
}

export interface Plan {
  readonly records: Readonly<Record<string, PassRecord>>;
  readonly missing: readonly Missing[];
}

/** Pass records of every done change except `except`: rule id → [change id, record], highest change number first. */
export function recordsOf(corpus: Corpus, except?: string): Map<string, { change: string; record: PassRecord }[]> {
  const out = new Map<string, { change: string; record: PassRecord }[]>();
  const done = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "done" && d.id !== except);
  done.sort((a, b) => number(b.id) - number(a.id));
  for (const c of done) for (const [id, record] of Object.entries(c.passes)) out.set(id, [...(out.get(id) ?? []), { change: c.id, record }]);
  return out;
}

const number = (id: string) => Number(id.split("-")[1]);

export function plan(input: PlanInput): Plan {
  const { corpus, change } = input;
  const others = recordsOf(corpus, change.id);
  const rules = new Map(corpus.docs.filter((d): d is Rule => d.kind === "rule").map((r) => [r.id, r]));
  const touched = touchedRules(input);
  const executed = executedRules(input);
  const records: Record<string, PassRecord> = {};
  const missing: Missing[] = [];
  for (const id of executed) {
    const rule = rules.get(id);
    if (!rule || rule.status !== "active") continue;
    const hash = behaviourHash(rule.body);
    if (!input.recorded?.has(id) && (others.get(id) ?? []).some((o) => o.record.hash === hash)) continue;
    if (touched.has(id)) records[id] = { hash, method: "test", wording: false };
    else if (rule.untested !== undefined && hasAcceptanceLine(change.body, id)) records[id] = { hash, method: "acceptance", wording: false };
    else {
      const before = passedVersion(input.root, input.head, rule, others);
      const now = behaviourParts(rule.body);
      if (before && before.parts.examples === now.examples && before.parts.statement !== now.statement) records[id] = { hash, method: before.record.method, wording: true };
      else missing.push({ id, untested: rule.untested !== undefined });
    }
  }
  if (!input.mainHasPasses) {
    const tested = testedRules(input.root, input.config, corpus);
    for (const rule of rules.values()) {
      // reason: a rule the change edits is executed by it, so it is never migrated as if no one had touched it (BR-2245, issue #104)
      if (rule.status !== "active" || executed.has(rule.id) || !tested.has(rule.id)) continue;
      records[rule.id] = { hash: behaviourHash(rule.body), method: "migration", wording: false };
    }
  }
  return { records: sorted(records), missing };
}

/**
 * BR-2241: the rules this execution covers, the change's `rules:` and every rule one of its landings changed the
 * behaviour hash of, compared by id between each range's base and head; a pure move keeps its hash and stays out.
 */
export function executedRules(input: Pick<PlanInput, "root" | "change" | "ranges" | "corpus">): Set<string> {
  const out = new Set(input.change.rules);
  const prefix = `${input.corpus.types.find((t) => t.name === "rule")!.prefix}-`;
  for (const r of input.ranges) {
    const diff = git(input.root, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", r.base, r.head, "--", "canon/rules");
    if (!diff.ok) continue;
    const ids = new Set(diff.value.split("\n").map((p) => p.split("/").pop()?.replace(/\.md$/, "") ?? "").filter((id) => id.startsWith(prefix)));
    if (ids.size === 0) continue;
    const before = rulesAt(input.root, r.base, ids);
    const after = rulesAt(input.root, r.head, ids);
    for (const id of ids) if (before.get(id)?.hash !== after.get(id)?.hash) out.add(id);
  }
  return out;
}

/** Status and behaviour hash of the rules `ids` in the tree at `ref`, by id, wherever under canon/rules their files are. */
export function rulesAt(root: string, ref: string, ids: ReadonlySet<string>): Map<string, { status: string; hash: string }> {
  const out = new Map<string, { status: string; hash: string }>();
  const files = git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref, "--", "canon/rules");
  if (!files.ok) return out;
  for (const path of files.value.split("\n")) {
    const id = path.split("/").pop()?.replace(/\.md$/, "");
    if (!id || !ids.has(id)) continue;
    const text = git(root, "show", `${ref}:${path}`);
    const parsed = text.ok ? parseDocFile(text.value, path) : undefined;
    if (!parsed?.ok) continue;
    out.set(id, { status: String(parsed.value.meta["status"] ?? "active"), hash: behaviourHash(parsed.value.body) });
  }
  return out;
}

function sorted(records: Record<string, PassRecord>): Record<string, PassRecord> {
  return Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.split("-")[0]!.localeCompare(b.split("-")[0]!) || number(a) - number(b)));
}

/** The acceptance section of a change (BR-2241). */
export const ACCEPTANCE_SECTION = "## 验收";

/** BR-2241: a line `- BR-n：<how it was checked> → <what was seen>` under `## 验收`, both sides filled. */
export function hasAcceptanceLine(body: string, id: string): boolean {
  const text = section(body, ACCEPTANCE_SECTION) ?? "";
  return text.split("\n").some((l) => {
    const m = /^\s*[-*+]\s+([A-Z][A-Z0-9]*-\d+)\s*[：:]\s*(.*?)\s*→\s*(.*?)\s*$/.exec(l);
    return m !== null && m[1] === id && m[2] !== "" && m[3] !== "";
  });
}

const JS_TS = /\.[cm]?[jt]sx?$/;
const DEFAULT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Whether a repository path is a test file by the config (BR-2005's files), judged by name so an earlier landing's files count too. */
function isTestPath(config: Config, path: string): boolean {
  if (path.split("/").includes("node_modules")) return false;
  if (config.tests) return config.tests.some((g) => new Bun.Glob(g).match(path));
  return DEFAULT_TEST.test(path.split("/").pop() ?? "") && !path.startsWith("canon/");
}

/**
 * BR-2241: rules named by a running test that one of the change's landings added, changed or removed a line in:
 * the lines of `git diff -U0 base head` on the new side, against the test's lines in the file at `head`.
 */
function touchedRules(input: PlanInput): Set<string> {
  const out = new Set<string>();
  const types = input.corpus.types;
  const prefix = `${types.find((t) => t.name === "rule")!.prefix}-`;
  for (const r of input.ranges) {
    const diff = git(input.root, "-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", r.base, r.head);
    if (!diff.ok) continue;
    for (const [path, lines] of newSideLines(diff.value)) {
      if (!isTestPath(input.config, path) || lines.length === 0) continue;
      const text = git(input.root, "show", `${r.head}:${path}`);
      if (!text.ok) continue;
      const titles = JS_TS.test(path) ? testTitles(text.value) : [{ title: text.value, runs: true, start: 1, end: Number.MAX_SAFE_INTEGER }];
      for (const t of titles) {
        if (!t.runs) continue;
        // reason: an added or changed line lies within the call; a deletion (`+c,0`) falls after line c, so c must be before its end
        if (!lines.some(([from, count]) => (count > 0 ? from <= t.end && from + count - 1 >= t.start : from >= t.start && from < t.end))) continue;
        for (const id of idsIn(types, t.title)) if (id.startsWith(prefix)) out.add(id);
      }
    }
  }
  return out;
}

/** Per file of a `-U0` diff, the new-side hunks as [first line, line count]; a deleted file has none. */
export function newSideLines(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      current = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (current !== undefined && !out.has(current)) out.set(current, []);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current !== undefined) out.get(current)!.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]);
  }
  return out;
}

/** Rules a running test title names in the tree at `root` (BR-2005's reading), for migration (BR-2245). */
export function testedRules(root: string, config: Config, corpus: Corpus): Set<string> {
  const out = new Set<string>();
  for (const file of testFilesFor(root, config)) {
    const src = readFileSync(join(root, file), "utf8");
    const titles = JS_TS.test(file) ? testTitles(src) : [{ title: src, runs: true }];
    for (const t of titles) if (t.runs) for (const id of idsIn(corpus.types, t.title)) out.add(id);
  }
  return out;
}

/**
 * BR-2243: the newest earlier version of the rule's file (following moves) whose behaviour hash some other done change
 * recorded, with that record; undefined when there is none.
 */
export function passedVersion(root: string, head: string, rule: Rule, others: Map<string, { change: string; record: PassRecord }[]>): { parts: { statement: string; examples: string }; record: PassRecord; body: string } | undefined {
  const known = others.get(rule.id) ?? [];
  if (known.length === 0) return undefined;
  const log = git(root, "-c", "core.quotePath=false", "log", "--follow", "--format=%x00%H", "--name-only", head, "--", rule.path);
  if (!log.ok) return undefined;
  for (const block of log.value.split("\0").slice(1)) {
    const [sha, ...rest] = block.split("\n").filter((l) => l !== "");
    const path = rest[0];
    if (!sha || !path) continue;
    const text = git(root, "show", `${sha}:${path}`);
    if (!text.ok) continue;
    const parsed = parseDocFile(text.value, path);
    if (!parsed.ok) continue;
    const hash = behaviourHash(parsed.value.body);
    const hit = known.find((k) => k.record.hash === hash);
    if (hit) return { parts: behaviourParts(parsed.value.body), record: hit.record, body: parsed.value.body };
  }
  return undefined;
}

/** The ranges earlier landings of `change` brought, from their `land.ok` events (BR-2241); events without `base` are older than this record. */
export function earlierLandings(db: CoordDb, change: string): Range[] {
  const rows = db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'land.ok' AND subject = ? ORDER BY id").all(change);
  const out: Range[] = [];
  for (const row of rows) {
    try {
      const d = JSON.parse(row.detail) as { base?: unknown; sha?: unknown };
      if (typeof d.base === "string" && typeof d.sha === "string") out.push({ base: d.base, head: d.sha });
    } catch {
      // reason: a detail that does not parse names no range; it cannot have come from a landing that recorded one
    }
  }
  return out;
}

/** Whether any done change in the tree at `ref` holds a pass record (BR-2245). */
export function hasPassesAt(root: string, ref: string): boolean {
  const files = git(root, "grep", "-l", "-e", "^passes:", ref, "--", "canon/changes");
  if (!files.ok || files.value === "") return false;
  for (const entry of files.value.split("\n")) {
    const path = entry.slice(ref.length + 1);
    const text = git(root, "show", `${ref}:${path}`);
    if (!text.ok) continue;
    const parsed = parseDocFile(text.value, path);
    if (!parsed.ok) continue;
    const passes = parsed.value.meta["passes"];
    if (parsed.value.meta["status"] === "done" && passes && typeof passes === "object" && Object.keys(passes).length > 0) return true;
  }
  return false;
}
