import type { Config } from "../../invocation/config.ts";
import { git } from "../../kernel/git.ts";
import { behaviourHash, formatPass, parsePasses } from "../../knowledge/documents/behaviour.ts";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import type { Change, Corpus, PassRecord, Rule } from "../../knowledge/documents/model.ts";
import { EXAMPLE_SECTION, RULE_SECTION, section } from "../../knowledge/documents/templates.ts";
import type { WordingQuestion } from "../../knowledge/review/review.ts";
import type { CoordDb } from "../db.ts";
import { earlierLandings, hasPassesAt, passedVersion, plan, recordsOf, rulesAt, type Missing, type Plan } from "./evidence.ts";

/** The execution checks a landing runs (D-32): before the close commit (BR-2241) and on the tree that becomes main (BR-2240, BR-2242, BR-2244). */

/** BR-2241, BR-2242: the records the close commit of `change` writes, computed on the worktree before it queues. */
export function planClose(db: CoordDb, config: Config, wt: string, main: string, corpus: Corpus, change: Change): Plan | { error: string } {
  const head = git(wt, "rev-parse", "HEAD");
  const base = git(wt, "merge-base", main, "HEAD");
  if (!head.ok) return { error: head.error.message };
  if (!base.ok) return { error: base.error.message };
  return plan({ root: wt, head: head.value, corpus, config, change, ranges: [...earlierLandings(db, change.id), { base: base.value, head: head.value }], mainHasPasses: hasPassesAt(wt, main) });
}

/** The `passes` value the close commit writes, or undefined when there is no record, so the key is left out (BR-2242). */
export function passesMeta(records: Readonly<Record<string, PassRecord>>): Record<string, string> | undefined {
  const entries = Object.entries(records);
  return entries.length === 0 ? undefined : Object.fromEntries(entries.map(([id, r]) => [id, formatPass(r)]));
}

/** The refusal text for rules without evidence (BR-2241). */
export function missingMessage(change: string, missing: readonly Missing[]): string {
  const lines = missing.map((m) =>
    `  - ${m.id}: change a line in a running test whose title names ${m.id}${m.untested ? `, or, as it has untested:, add a line "- ${m.id}：<怎么验的> → <看到了什么>" under ## 验收 in ${change}` : ""}`,
  );
  return `${change} executes ${missing.length} rule(s) with no evidence of this execution (BR-2241, D-32): each rule it executes, the ones in its rules: and every one its landings changed the ## 规则 or ## 例子 of, that is active and has no pass record of its current text needs one:\n${lines.join("\n")}\nA rule that only changed wording since it last passed needs no evidence when its ## 例子 is unchanged (BR-2243). Commit, then land --finish again.`;
}

export type LandingExecution =
  | { readonly ok: true; readonly wording: readonly WordingQuestion[] }
  | { readonly ok: false; readonly reason: "activate" | "rule-changed" | "passes"; readonly message: string };

interface Input {
  readonly db: CoordDb;
  /** The config of the landing tree: its `tests` decide which files are tests (BR-2241). */
  readonly config: Config;
  readonly wt: string;
  readonly base: string;
  readonly head: string;
  /** The change's branch before the rebase, where its close commit's records were computed (BR-2244). */
  readonly before: string;
  readonly corpus: Corpus;
  readonly subject: string | null;
  /** The main branch's name, for the message. */
  readonly main: string;
}

/** A document's front matter as it was at `ref`, or undefined when the file was not there. */
function metaAt(wt: string, ref: string, path: string): Record<string, unknown> | undefined {
  const text = git(wt, "show", `${ref}:${path}`);
  if (!text.ok) return undefined;
  const parsed = parseDocFile(text.value, path);
  return parsed.ok ? parsed.value.meta : undefined;
}

const same = (a: Readonly<Record<string, PassRecord>>, b: Readonly<Record<string, PassRecord>>): boolean => {
  const fa = Object.entries(a).map(([id, r]) => `${id}=${formatPass(r)}`).sort();
  const fb = Object.entries(b).map(([id, r]) => `${id}=${formatPass(r)}`).sort();
  return fa.length === fb.length && fa.every((x, i) => x === fb[i]);
};

/**
 * The landing's execution checks on the tree at `head` (rebased onto main at `base`): planned rules made active only
 * by a change that lists them (BR-2240); no pass record edited except the closing change's own, and that one equal to
 * what canon computes here (BR-2242, BR-2245); every record still matching its rule after the rebase (BR-2244).
 */
export function landingExecution(i: Input): LandingExecution {
  const { wt, base, head, corpus } = i;
  const diff = git(wt, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", base, head, "--", "canon/rules", "canon/changes");
  const entries = (diff.ok && diff.value !== "" ? diff.value.split("\n") : []).map((l) => {
    const [status, path] = l.split("\t") as [string, string];
    return { status: status[0]!, path };
  });
  const change = i.subject ? corpus.docs.find((d): d is Change => d.kind === "change" && d.id === i.subject) : undefined;

  // BR-2240: planned on main, active in the landing tree.
  const wasPlanned = new Set<string>();
  for (const e of entries) {
    if (e.status === "A" || !e.path.startsWith("canon/rules/") || e.path.endsWith("/README.md")) continue;
    const meta = metaAt(wt, base, e.path);
    if (meta?.["status"] === "planned" && typeof meta["id"] === "string") wasPlanned.add(meta["id"]);
  }
  const activated = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status === "active" && wasPlanned.has(d.id)).map((r) => r.id);
  const unlisted = activated.filter((id) => !change?.rules.includes(id));
  if (unlisted.length > 0) {
    const who = change ? `${change.id} does not list them in its rules:` : "this landing belongs to no change";
    return { ok: false, reason: "activate", message: `${unlisted.join(", ")} turn from planned to active, but ${who}; only a change that lists a planned rule in its rules: may make it active (BR-2240)` };
  }

  // BR-2242: pass records change only as the close commit of the closing change writes them.
  const byPath = new Map(corpus.docs.filter((d): d is Change => d.kind === "change").map((c) => [c.path, c]));
  const baseMeta = change ? metaAt(wt, base, change.path) : undefined;
  const closing = change !== undefined && change.status === "done" && baseMeta?.["status"] !== "done";
  const edited: string[] = [];
  for (const e of entries) {
    if (e.status === "D" || !e.path.startsWith("canon/changes/")) continue;
    const now = byPath.get(e.path);
    if (!now || (closing && now.id === change!.id)) continue;
    const before = e.status === "A" ? {} : parsePasses(metaAt(wt, base, e.path)?.["passes"]);
    if (typeof before === "string" || !same(before, now.passes)) edited.push(now.id);
  }
  if (edited.length > 0) return { ok: false, reason: "passes", message: `the pass records of ${edited.join(", ")} differ from ${base.slice(0, 9)}: only canon writes them, in the close commit of the change itself (BR-2242); take the edit out` };
  if (!closing) return { ok: true, wording: [] };

  // BR-2244: every rule the change lists or recorded, as it was on the branch before the rebase, must have the same
  // behaviour and status after it; otherwise main changed it while this landing waited.
  const rules = new Map(corpus.docs.filter((d): d is Rule => d.kind === "rule").map((r) => [r.id, r]));
  const executed = [...new Set([...change.rules, ...Object.keys(change.passes)])];
  const was = rulesAt(wt, i.before, new Set(executed));
  const moved: string[] = [];
  for (const id of executed) {
    const rule = rules.get(id);
    const then = was.get(id);
    const now = rule ? { status: rule.status, hash: behaviourHash(rule.body) } : undefined;
    if (then === undefined && now === undefined) continue;
    if (then?.status !== now?.status || then?.hash !== now?.hash) moved.push(`${id} (${then ? `${then.status} ${then.hash}` : "absent"} → ${now ? `${now.status} ${now.hash}` : "absent"})`);
  }
  for (const [id, r] of Object.entries(change.passes)) {
    const rule = rules.get(id);
    if ((!rule || rule.status !== "active" || behaviourHash(rule.body) !== r.hash) && !moved.some((m) => m.startsWith(`${id} `))) moved.push(`${id} (recorded ${r.hash})`);
  }
  if (moved.length > 0) {
    return { ok: false, reason: "rule-changed", message: `rules ${change.id} executes changed on ${i.main} while it was landing: ${moved.join(", ")}. Run git rebase ${i.main}, verify against the new text (change the test or the ## 验收 line), then land --finish again (BR-2244)` };
  }
  const expected = plan({ root: wt, head, corpus, config: i.config, change, ranges: [...earlierLandings(i.db, change.id), { base, head }], mainHasPasses: hasPassesAt(wt, base), recorded: new Set(Object.keys(change.passes)) });
  if (expected.missing.length > 0 || !same(expected.records, change.passes)) {
    const want = Object.entries(expected.records).map(([id, r]) => `${id}: ${formatPass(r)}`);
    return { ok: false, reason: "passes", message: `the pass records of ${change.id} are not the ones canon computes on the landing tree (BR-2242, BR-2245)${expected.missing.length ? `; without evidence: ${expected.missing.map((m) => m.id).join(", ")}` : ""}\n  computed: ${want.length ? want.join(", ") : "(none)"}\n  in ${change.path}: ${Object.entries(change.passes).map(([id, r]) => `${id}: ${formatPass(r)}`).join(", ") || "(none)"}\nLand --finish again from the change's worktree; canon writes them itself` };
  }
  const others = recordsOf(corpus, change.id);
  const wording: WordingQuestion[] = [];
  for (const [id, r] of Object.entries(change.passes)) {
    if (!r.wording) continue;
    const rule = rules.get(id)!;
    const before = passedVersion(wt, head, rule, others);
    wording.push({ id, title: rule.title, before: before ? (section(before.body, RULE_SECTION) ?? "") : "", after: section(rule.body, RULE_SECTION) ?? "", examples: section(rule.body, EXAMPLE_SECTION) ?? "" });
  }
  return { ok: true, wording };
}

/** BR-2239: the rules the review did not judge as wording-only edits; empty when every one is "wording". */
export function unconfirmedWording(questions: readonly WordingQuestion[], answers: Readonly<Record<string, string>> | undefined): string[] {
  return questions.filter((q) => answers?.[q.id] !== "wording").map((q) => q.id);
}

/** The refusal text when the review does not confirm a wording-only edit (BR-2239). */
export function wordingMessage(ids: readonly string[], answers: Readonly<Record<string, string>> | undefined, configured: boolean): string {
  const why = configured ? ids.map((id) => `${id}: the review answered ${answers?.[id] === undefined ? "nothing" : JSON.stringify(answers[id])}`).join("; ") : "no review command is configured to judge them";
  return `the close commit records ${ids.join(", ")} as wording-only edits, but the rule review did not judge them so (${why}) (BR-2239). Execute them as behaviour changes: change a line in a running test whose title names each, or for a rule with untested:, a line under ## 验收; then land --finish again`;
}
