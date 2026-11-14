import { SKILL_DIRS, standingInstructions } from "../../kernel/agent.ts";
import { restatementLine, type Restatement } from "../check/restatement/restatement.ts";
import { realpathSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { stripCode, type Corpus, type Doc, type Domain, type Rule } from "../documents/model.ts";
import { idsIn } from "../documents/types.ts";
import { contextFor, referencedIds, renderContext, ruleSection, type Context } from "../query/query.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { LESSONS_SECTION, section } from "../documents/templates.ts";
import { shippedUnedited } from "../../install/install.ts";

/**
 * AI review of rule and decision text, the one place the data showed AI judgment pays (spec/ADR rejects
 * 15/15 real). It sees the whole domain each changed rule belongs to, not a slice, and runs on the exact
 * tree that is landing. The reviewer is any command: prompt on stdin, JSON verdict on stdout.
 */
export interface ReviewVerdict {
  readonly verdict: "ok" | "block";
  readonly findings: readonly string[];
  /** Per rule asked about in `# Wording judgements`, what the reviewer answered (BR-2239); absent when it gave none. */
  readonly wording?: Readonly<Record<string, string>>;
}

/** A rule whose 规则 section changed while its examples did not, for the review to judge wording or behaviour (BR-2239, BR-2243). */
export interface WordingQuestion {
  readonly id: string;
  readonly title: string;
  /** The 规则 section of the version that passed before, and of the current version. */
  readonly before: string;
  readonly after: string;
  readonly examples: string;
}

/** A rule or decision file the landing deletes, with the text it had on main. */
export interface DeletedDoc {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

/** The lines a landing adds or changes in a rule or decision that was already on main (BR-2405). */
export interface AddedLines {
  readonly id: string;
  readonly path: string;
  readonly lines: readonly { readonly line: number; readonly text: string }[];
}

export interface ReviewExtras {
  readonly deleted?: readonly DeletedDoc[];
  /** Domains whose README the landing changes; the review sees each whole domain. */
  readonly readmes?: readonly string[];
  /** Domain READMEs the landing deletes, with the text they had on main. */
  readonly deletedReadmes?: readonly { readonly path: string; readonly text: string }[];
  /** The change this landing belongs to; the review reads its lessons (BR-2162). */
  readonly change?: Doc | undefined;
  /** Rules the closing change recorded as wording-only edits; the review must judge each (BR-2239). */
  readonly wording?: readonly WordingQuestion[];
  /** The architecture overview, when the project has one with content: its text, and the diff this landing makes to it (empty when it does not touch it) (BR-2009, D-65). */
  readonly architecture?: { readonly text: string; readonly diff: string };
  /**
   * An incremental review (BR-2396, D-81): the changed documents passed the full review `from`, and `added` are the active
   * rules and accepted decisions that landed on main since; the prompt says so and shows them whole.
   */
  readonly incremental?: { readonly from: number; readonly added: readonly Doc[] };
  /** The lines this landing adds or changes in the changed rules and decisions that were already on main (BR-2405). */
  readonly added?: readonly AddedLines[];
  /** Restatements the text test finds in the added lines, given to the review as hints (BR-2405). */
  readonly restatements?: readonly Restatement[];
  /**
   * One part of a review whose changed documents do not fit one call (BR-2448): this is part `i` of `n`, and `others` are the
   * changed documents the other parts show in full, listed here by id, title and first line.
   */
  readonly part?: { readonly i: number; readonly n: number; readonly others: readonly Doc[] };
}

/** The key of each blocking criterion in the prompts, and `note` for a remark that never blocks (BR-2367, D-74). */
export const RULE_CRITERIA = ["contradiction", "untestable", "no-rejected-options", "release", "amends", "overview", "restatement", "business-overlap"] as const;
export const DUPLICATE_CRITERIA = ["duplication"] as const;
const CRITERIA: readonly string[] = [...RULE_CRITERIA, ...DUPLICATE_CRITERIA];
const ANSWER_FORMAT_RULE = `{"findings":[{"criterion":"${RULE_CRITERIA.join('"|"')}"|"note","text":"<one sentence, naming the id>"}]`;
export const NO_VERDICT = "Do not give a verdict: canon derives it from the keys.";

/** What each blocking criterion means, as the review prompt states it; the verifier is shown the same words (BR-2367, BR-2442). */
export const CRITERION_TEXT: Readonly<Record<string, string>> = {
  // reason: a contradiction must be shown, not felt: two passages and one input they answer differently; else a fix only rewords (D-115)
  contradiction: "`contradiction`: a rule that contradicts another active rule (in any domain: see the rule index) or an accepted decision: for one input or state the two give different results. Quote both passages and name that input and the two results; a tension you cannot show that way is a `note`.",
  // reason: an experience goal accepted by a person is not untestable; asking to drop it made agents cut the owner's goals (D-115)
  untestable: "`untestable`: a rule a test cannot decide (vague, no boundary, examples that do not pin the boundary) and that says no other way to decide it. A rule with `untested:` whose `## 验收` says how a person accepts it (a goal such as feel, look or being worth sharing) is not untestable. Never ask to delete, narrow or widen a goal or commitment to make it testable: ask for a boundary or a way to accept it.",
  "no-rejected-options": "`no-rejected-options`: a decision without the options it rejected.",
  release: "`release`: a release is a version's PRD; the rules whose front matter says `release: R-n` are its behaviour. A rule tagged with a release that does something that release's 不做 excludes or lies outside its 范围; a release whose 不做 contradicts its own 范围 or a rule tagged with it. Only a rule or release changed in this landing can be blocked for it.",
  amends: "`amends`: a changed decision that replaces only part of an accepted decision must list it in `amends:` (one that replaces a whole decision uses `supersedes:`); a decision that says it changes part of another decision without listing it in `amends:`.",
  overview: "`overview`: when an architecture overview is shown below, it is where readers start, not the judge: where it disagrees with the active rules and accepted decisions, they win. Use this key only when the part of the overview this landing changed (its diff is shown) contradicts an active rule or an accepted decision. When a rule or decision changed in this landing makes a statement in the overview wrong, add a `note` naming the overview section.",
  restatement: "`restatement`: a changed rule or decision that, in a line this landing adds or changes, states again a behaviour another rule already states (its conditions, outcomes, numbers or order) and states it differently from that rule: another condition, outcome, number or order than the rule it copies, so the two now disagree. Quote both. A restatement that agrees with the rule it copies is a `note`, never this key: it only goes stale if that rule changes. Not a restatement at all: a line that already names the other rule (按 BR-x, 见 BR-x) and adds a few words saying which of its behaviours is meant (按 BR-11 的侦测半径); what this document adds to the other rule; a decision's source line (来源：) quoting its target; a decision's 决定 naming the rule it produced. The lines this landing adds or changes are listed under # Lines added or changed in this landing; a changed rule or decision with no entry there is new, and all of its lines are. A restatement only in lines this landing did not add or change is a `note`. Name both ids and quote the restating words.",
  // reason: a business is a name several rules point at; two names for one thing scatter a boundary again, and no count can tell them apart (BR-2447, D-98)
  "business-overlap": "`business-overlap`: a domain README's `## 业务` section lists the businesses that domain covers; a business is one boundary several of its rules draw together, not the title of a single rule. Use this key when this landing adds a line to a `## 业务` section whose business covers the same ground as another business the same domain already lists, or renames part of one. Name both business names and the domain. A line this landing did not add is a `note`; so is an overlap between two businesses it did not touch.",
  duplication: "`duplication`: one requirement (an instruction, a condition or a qualifier) is stated in two standing texts, or twice in one of them, in any wording or language, and at least one of the two places is in a line this landing added or changed.",
};

/** The review prompt with every affected domain's whole text in it, however large. */
export function reviewPrompt(root: string, corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras = {}): string {
  const contexts = contextTops(corpus, changed, extras).map((top) => contextSection(root, corpus, top));
  return [...promptHead(corpus, changed, extras), ...contexts, ...promptTail(corpus)].join("\n");
}

/** One document as the prompt shows it: id, title, kind and status, a decision's links, its body. */
function docSection(d: Doc): string {
  // reason: the body has no front matter, so the reviewer could not see what a decision supersedes or amends (BR-2141),
  // reason: nor which business a rule draws a boundary of, which `business-overlap` has to judge (BR-2447)
  const links = d.kind === "decision" ? [...(d.supersedes.length ? [`supersedes: ${d.supersedes.join(", ")}`] : []), ...(d.amends.length ? [`amends: ${d.amends.join(", ")}`] : [])] : d.kind === "rule" && d.business !== undefined ? [`business: ${d.business}`] : [];
  return `## ${d.id} ${d.title} (${d.kind}${"status" in d ? `, ${d.status}` : ""})\n\n${links.map((l) => `${l}\n`).join("")}${links.length ? "\n" : ""}${d.body.trim()}\n`;
}

/** Everything in the prompt before the affected domains' text; `note` is a line for the reviewer after the answer format. */
function promptHead(corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras, note?: string): string[] {
  const parts: string[] = [
    "You review changes to a project's rules and decisions. Rules are the current truth of what the product must do; decisions record why.",
    // reason: each blocking criterion has a key the reviewer must name on a finding, so canon derives the verdict and a finding that matches a criterion cannot pass as a note (BR-2367, D-74)
    "Every blocking criterion below has a key in backticks. A finding that matches one is given with that key; every other remark is given with the key `note`, which never blocks.",
    // reason: each criterion's meaning lives in CRITERION_TEXT so the verifier reads the same words (BR-2442): release covers a release's 不做 and 范围 (D-61), overview only text this landing wrote into it (BR-2009, D-65), restatement only lines this landing wrote (BR-2405, D-84, #177)
    ...RULE_CRITERIA.map((c) => CRITERION_TEXT[c]!),
    NO_VERDICT,
    // reason: a defect left out blocks a later landing of the same text, and each call reports what it happens to notice (BR-2009, #173)
    "List every blocking defect you find, not only the first: a defect you leave out blocks a later landing of the same text. A blocking finding must involve at least one changed or deleted document; a defect only between documents this landing does not change is a `note`.",
    "Do not block for wording, style or formatting.",
    "One rule is one trigger (one command, event or kind of input) and one outcome (D-5). The error cases, exit codes and boundaries of the same trigger belong in that rule as examples, and a definition table (such as a list of exit codes) is one rule: do not suggest splitting those. Suggest a split only when a rule covers two different triggers, or two outcomes that could change independently; never block for it.",
    "Write the findings in the language the documents are written in.",
    // reason: turning a lesson into a mechanism needs the owner's confirmation; the review only reminds, never blocks (BR-2162, D-24);
    // a change's own rules and tests for its own feature or fix are not lessons and need no confirmation (D-78)
    "When the change's lessons section is shown below, add a note (never block for it) naming the change id: for a lesson marked text-only (只靠文字) without a reason although a rule, check or command could enforce it; and for a lesson about the process or tools whose mechanism is a rule, check or command this landing adds (in the changed documents) when the lesson does not say the owner confirmed it. A rule, test or check the change writes for its own feature or fix is not a lesson: give no note asking for the owner's confirmation of it.",
    extras.wording?.length
      ? `Answer with JSON only: ${ANSWER_FORMAT_RULE}, "wording":{"<rule id>":"wording"|"behaviour"}}, with one wording entry per rule under # Wording judgements`
      : `Answer with JSON only: ${ANSWER_FORMAT_RULE}}`,
    ...(note ? [note] : []),
    ...(extras.part ? [partNote(extras.part.i, extras.part.n)] : []),
    "",
  ];
  if (extras.wording?.length) parts.push(...wordingSection(extras.wording));
  if (extras.part) {
    parts.push("# Other changed documents in this landing (only id, title and first line here; each is reviewed in full in another part)", "");
    parts.push(...extras.part.others.map((d) => `- ${d.id} ${d.title} (${d.kind}${"status" in d ? `, ${d.status}` : ""}): ${firstLine(d)}`), "");
  }
  parts.push("# Changed documents (new text)");
  for (const d of changed) parts.push(docSection(d));
  if (extras.added?.length) {
    parts.push("# Lines added or changed in this landing", "", "For each changed rule or decision that was already on main, the lines this landing adds or changes (line number in the file, then the line). A changed rule or decision not listed here is new: all of its lines are.", "");
    for (const a of extras.added) parts.push(`## ${a.id} (${a.path})\n\n${a.lines.length ? a.lines.map((l) => `${l.line}: ${l.text}`).join("\n") : "(only lines removed)"}\n`);
  }
  if (extras.restatements?.length) {
    parts.push("# Possible restatements found by shared wording (hints: judge each yourself; a restatement in other words is not listed)", "", ...extras.restatements.map((r) => `- ${restatementLine(r)}`), "");
  }
  if (extras.incremental) {
    // reason: the changed text already passed a full review against its whole domains; only what landed since is new to it (BR-2396, D-81)
    parts.push(
      "# Incremental review",
      "",
      `The changed documents above, with exactly this text, passed a full review (event ${extras.incremental.from}) that saw the whole of their domains and the indexes. Since then the documents below landed on main. Judge only the changed documents against these documents: a criterion that holds between them blocks as usual. The domain text and the indexes further below hold only the changed and the newly landed documents, not whole domains: say nothing about what is missing from them.`,
      "",
      "## Documents landed on main since the passing review",
      "",
    );
    for (const d of extras.incremental.added) parts.push(docSection(d));
  }
  if (extras.architecture) {
    const { text, diff } = extras.architecture;
    parts.push(`# Architecture overview (canon/architecture.md, ${diff.trim() === "" ? "not changed in this landing" : "changed in this landing; the diff follows the text"})\n\n${text.trim()}\n`);
    if (diff.trim() !== "") parts.push(`## Diff of the overview in this landing\n\n${diff.trim()}\n`);
  }
  // reason: the review of a rule tagged with a release must see that release's 范围 and 不做, and that of a release the rules tagged with it (D-61, BR-2009)
  const releaseIds = new Set<string>();
  for (const d of changed) {
    if (d.kind === "release") releaseIds.add(d.id);
    else if (d.kind === "rule" && d.release !== undefined) releaseIds.add(d.release);
  }
  const changedIds = new Set(changed.map((d) => d.id));
  for (const id of [...releaseIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const release = corpus.docs.find((d) => d.kind === "release" && d.id === id);
    if (!release || release.kind !== "release") continue;
    const tagged = corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired" && d.release === id);
    parts.push(`# Release ${release.id} ${release.title} (${release.status})${changedIds.has(id) ? " (new text shown above)" : ""}\n\n${changedIds.has(id) ? "" : `${release.body.trim()}\n\n`}Rules tagged ${id}:\n${tagged.length ? tagged.map((r) => `- ${r.id} [${r.domain}]${r.status === "planned" ? " [规划中]" : ""} ${r.title}`).join("\n") : "(none)"}\n`);
  }
  const change = extras.change;
  if (change?.kind === "change") {
    const lessons = section(change.body, LESSONS_SECTION);
    if (lessons !== undefined) parts.push(`# Lessons of ${change.id} ${change.title} (the change this landing belongs to)\n\n${lessons.trim()}\n`);
  }
  if (extras.deleted?.length || extras.deletedReadmes?.length) {
    parts.push("# Deleted documents (text on main before this landing; deleting a rule removes a behaviour the product promised, retiring it keeps the record)");
    for (const d of extras.deleted ?? []) parts.push(`## ${d.id} — deleted ${d.path}\n\n${d.text.trim()}\n`);
    for (const r of extras.deletedReadmes ?? []) parts.push(`## deleted domain README ${r.path}\n\n${r.text.trim()}\n`);
  }
  if (extras.readmes?.length) parts.push(`# Domain READMEs changed: ${extras.readmes.join(", ")} (their new text is in the current context below)`);
  return parts;
}

/** What a part of a review split by its changed documents tells the reviewer (BR-2448). */
function partNote(i: number, n: number): string {
  return `This landing changed more documents than one call can hold, so they are reviewed in ${n} parts; this is part ${i} of ${n}. Only this part's changed documents are shown in full under # Changed documents; the other changed documents are listed by id, title and first line under # Other changed documents in this landing. Judge the documents shown in full against everything shown; a contradiction with another changed document can be found only from what that list shows, and never block because a changed document is not shown in full in this part.`;
}

/** A document's first line of text after its headings, at most 200 characters, for the list of the other changed documents (BR-2448). */
function firstLine(d: Doc): string {
  const line = d.body.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#")) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** The `# Wording judgements` section: each rule's 规则 before and now, and its unchanged 例子 (BR-2239). */
function wordingSection(questions: readonly WordingQuestion[]): string[] {
  // reason: the close commit recorded these as wording-only edits; only this independent judgement lets them keep the earlier pass (BR-2239, D-32)
  const parts = [
    "# Wording judgements",
    "",
    'Each rule below changed only its 规则 section since the version that passed; its examples are the same. Answer "wording" when the edit changes no requirement (the product must do exactly what it had to before, for every input), "behaviour" when it adds, removes or changes any requirement, condition or boundary. When unsure, answer "behaviour". This judgement does not affect the verdict.',
    "",
  ];
  for (const q of questions) parts.push(`## ${q.id} ${q.title}\n\n### 规则 before\n\n${q.before.trim()}\n\n### 规则 now\n\n${q.after.trim()}\n\n### 例子 (unchanged)\n\n${q.examples.trim()}\n`);
  return parts;
}

/**
 * The landing's wording call (BR-2239): only the wording judgements, no rule review, which runs after the landing (D-89).
 * The answer is a review answer with no findings and a `wording` entry per rule.
 */
export function wordingPrompt(questions: readonly WordingQuestion[]): string {
  return [
    "You judge edits to a project's rules. Rules are the current truth of what the product must do.",
    'Answer with JSON only: {"findings":[],"wording":{"<rule id>":"wording"|"behaviour"}}, with one wording entry per rule below.',
    "",
    ...wordingSection(questions),
  ].join("\n");
}

/** The top-level domains whose whole text the review shows, in the order it shows them (BR-2009, #133). */
function contextTops(corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras): string[] {
  const out = new Set<string>();
  for (const n of extras.readmes ?? []) out.add(n.split("/")[0]!);
  for (const d of changed) {
    // reason: the review reads the whole top-level domain, so a contradiction across its subdomains is still seen (BR-2113);
    // a decision or release brings the top-level domains of the rules it names, each given once however many name it (BR-2009, #133)
    for (const top of d.kind === "rule" ? [d.domain.split("/")[0]!] : namedTops(corpus, d)) out.add(top);
  }
  // reason: a deletion affects the domain it leaves, so the review sees what remains there (BR-2009, #74):
  // a deleted rule's top-level domain, and the top-level domains of the rules a deleted decision named on main
  for (const top of deletedDomains(corpus, extras.deleted ?? [])) out.add(top);
  return [...out];
}

const contextHeader = (top: string): string => `# Current context for ${top}\n\n`;

function contextSection(root: string, corpus: Corpus, top: string): string {
  return `${contextHeader(top)}${renderContext(root, contextFor(corpus, top), { full: true })}`;
}

/** The rule index and the accepted decisions' titles, which every call of a split review carries. */
function promptTail(corpus: Corpus): string[] {
  const parts: string[] = [];
  // reason: planned rules constrain execution too, so a contradiction with one is found as well (BR-2036, BR-2235)
  const index = corpus.docs.filter((d) => d.kind === "rule" && d.status !== "retired");
  parts.push(`# Rule index (every active and planned rule, all domains)\n\n${index.map((r) => `- ${r.id} [${r.kind === "rule" ? r.domain : ""}]${r.kind === "rule" && r.status === "planned" ? " [规划中]" : ""}${r.kind === "rule" && r.release ? ` [${r.release}]` : ""} ${r.title}`).join("\n")}`);
  const accepted = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted");
  if (accepted.length) parts.push(`# Accepted decisions\n\n${accepted.map((d) => `- ${d.id} ${d.title}`).join("\n")}`);
  return parts;
}

/** Top-level domains of the current rules a changed document names, in corpus order. */
function namedTops(corpus: Corpus, doc: Doc): string[] {
  const named = referencedIds(doc, corpus.types);
  const tops = new Set(corpus.docs.filter((x): x is Rule => x.kind === "rule" && named.has(x.id)).map((r) => r.domain.split("/")[0]!));
  return corpus.domains.filter((d) => !d.parent && tops.has(d.name)).map((d) => d.name);
}

/** Top-level domains, still in the corpus, that the deleted documents belonged to or named. */
function deletedDomains(corpus: Corpus, deleted: readonly DeletedDoc[]): string[] {
  const out = new Set<string>();
  const exists = (name: string) => corpus.domains.some((d) => d.name === name);
  for (const d of deleted) {
    const m = d.path.match(/^canon\/rules\/(.+)\/[^/]+$/);
    if (m) {
      if (exists(m[1]!.split("/")[0]!)) out.add(m[1]!.split("/")[0]!);
      continue;
    }
    const named = idsIn(corpus.types, stripCode(d.text));
    for (const r of corpus.docs.filter((x): x is Rule => x.kind === "rule" && named.has(x.id))) if (exists(r.domain.split("/")[0]!)) out.add(r.domain.split("/")[0]!);
  }
  return [...out];
}

/** The two ways a review runs: for a landing (`land`) or for `canon work review` (`preview`). */
export type ReviewKind = "land" | "preview" | "release" | "reconcile";

/** How a review run is bounded: its time limit, and where a signal handler finds it to stop it (BR-2296). */
export interface ReviewLimits {
  readonly timeoutMs: number;
  /** Which review this is; the command is told in `CANON_REVIEW_KIND` (BR-2366). */
  readonly kind: ReviewKind;
  /** Called with the running review's stopper when it starts, and with undefined when it has ended. */
  readonly track?: (running: { kill(): void } | undefined) => void;
}

/** Why a review command exited non-zero: stderr's head, else stdout's tail, both labelled when both exist (BR-2216, #132). */
function failureMessage(code: number, errText: string, out: string): string {
  const e = errText.trim();
  const o = out.trim();
  // reason: `claude -p` prints its error (e.g. "Prompt is too long") on stdout and leaves stderr empty; the cause is usually at the end (BR-2216)
  if (e && o) return `review command exited ${code} (stderr): ${e.slice(0, 500)}; (stdout): ${o.slice(-500)}`;
  if (o) return `review command exited ${code} (stdout): ${o.slice(-500)}`;
  return `review command exited ${code}: ${e ? e.slice(0, 500) : "no output"}`;
}

/**
 * Runs `command` with `prompt` on stdin in its own process group, bounded by `limits` (BR-2216, BR-2296), and returns the
 * JSON between the first `{` and the last `}` of its stdout, parsed. Shared by the reviews and the verifier (BR-2442).
 */
export async function runJsonCommand(command: string, cwd: string, prompt: string, limits: ReviewLimits): Promise<Result<unknown>> {
  // reason: its own process group, so a timeout or a signal stops the reviewer's children too (claude under sh), not only sh (BR-2296)
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", detached: true, env: { ...process.env, CANON_REVIEW_KIND: limits.kind } });
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // reason: the group is already gone; nothing is left to stop
    }
  };
  limits.track?.({ kill });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, limits.timeoutMs);
  let out: string, errText: string, code: number;
  try {
    [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    clearTimeout(timer);
    limits.track?.(undefined);
  }
  if (timedOut) return err("io", `review command did not finish within ${limits.timeoutMs / 60_000} minute(s) (review_timeout_minutes) and was stopped with its children`);
  if (code !== 0) return err("io", failureMessage(code, errText, out));
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return err("invalid", `review command printed no JSON: ${out.trim().slice(0, 300)}`);
  try {
    return ok(JSON.parse(match[0]) as unknown);
  } catch (e) {
    return err("invalid", `review JSON does not parse: ${(e as Error).message}`);
  }
}

/** How one answer becomes a verdict; the release check passes its own, which places each finding (BR-2411, D-107). */
export type AnswerParser = (answer: unknown) => Result<ReviewVerdict>;

export async function runReview(command: string, cwd: string, prompt: string, limits: ReviewLimits, parse: AnswerParser = parseAnswer): Promise<Result<ReviewVerdict>> {
  const v = await runJsonCommand(command, cwd, prompt, limits);
  return v.ok ? parse(v.value) : v;
}

/** What one review answer means: the verdict canon derives, the findings as text, the wording answers (BR-2367, D-74). */
export function parseAnswer(v: unknown): Result<ReviewVerdict> {
  const a = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as { verdict?: unknown; findings?: unknown; wording?: unknown }) : {};
  const w = a.wording;
  const wording = w !== null && typeof w === "object" && !Array.isArray(w) ? Object.fromEntries(Object.entries(w as Record<string, unknown>).map(([k, x]) => [k, String(x)])) : undefined;
  const extra = wording ? { wording } : {};
  const list = Array.isArray(a.findings) ? a.findings : [];
  const isObject = (f: unknown): boolean => f !== null && typeof f === "object" && !Array.isArray(f);
  if (!list.some(isObject)) {
    // reason: an answer in the format before BR-2367 has no criterion on its findings; its `verdict` is taken as stated, never guessed (D-74)
    const findings = list.map(String);
    if (a.verdict === "ok" || a.verdict === "block") return ok({ verdict: a.verdict, findings, ...extra });
    if (a.verdict === undefined && Array.isArray(a.findings) && list.length === 0) return ok({ verdict: "ok", findings: [], ...extra });
    return err("invalid", a.verdict === undefined ? `review answer has no verdict and no findings with a criterion: ${JSON.stringify(a.findings ?? null).slice(0, 200)}` : `review verdict must be "ok" or "block", got ${JSON.stringify(a.verdict)}`);
  }
  const findings: string[] = [];
  let blocking = false;
  for (const [i, f] of list.entries()) {
    const bad = (why: string) => err("invalid", `review finding ${i + 1} ${why}; each finding is {"criterion":"<${CRITERIA.join("|")}|note>","text":"<sentence>"}`);
    if (!isObject(f)) return bad("is not an object");
    const { criterion, text } = f as { criterion?: unknown; text?: unknown };
    if (typeof text !== "string" || text.trim() === "") return bad("has no text");
    if (criterion === "note") findings.push(text);
    else if (typeof criterion === "string" && CRITERIA.includes(criterion)) {
      blocking = true;
      findings.push(`[${criterion}] ${text}`);
    } else return bad(`has criterion ${JSON.stringify(criterion ?? null)}, not a criterion name or "note"`);
  }
  return ok({ verdict: blocking ? "block" : "ok", findings, ...extra });
}

/** Text every session reads at start, gathered from the tree that is landing (BR-2143). */
export interface StandingText {
  /** The configured instruction files that exist, path and whole text. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** Each project skill's front-matter description, the only part of a skill loaded into every session; `shipped` when canon wrote it and the project left it as written (BR-2410). */
  readonly skills: readonly { readonly path: string; readonly description: string; readonly shipped?: boolean }[];
}

export const SKILL_FILE = /^\.(?:claude|agents)\/skills\/[^/]+\/SKILL\.md$/;

export function standingText(root: string, instructions: readonly string[]): StandingText {
  const shipped = shippedUnedited(root);
  const files = standingInstructions(instructions).filter((p) => existsSync(join(root, p))).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const skills: { path: string; description: string; shipped?: boolean }[] = [];
  const seen = new Set<string>();
  for (const skillDir of Object.values(SKILL_DIRS)) {
    const dir = join(root, skillDir);
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const path = `${skillDir}/${name}/SKILL.md`;
      if (!existsSync(join(root, path))) continue;
      const physical = realpathSync(join(root, path));
      if (seen.has(physical)) continue;
      seen.add(physical);
      const front = readFileSync(join(root, path), "utf8").match(/^---\n([\s\S]*?)\n---/);
      let description: string;
      try {
        const meta = front ? (parse(front[1]!) as { description?: unknown } | null) : null;
        description = typeof meta?.description === "string" ? meta.description : "(no description)";
      } catch (e) {
        description = `(front matter does not parse: ${(e as Error).message.split("\n")[0]})`;
      }
      skills.push({ path, description, ...(shipped.has(path) ? { shipped: true } : {}) });
    }
  }
  return { files, skills };
}

const SHIPPED_NOTE = "A description marked `(shipped by canon)` is written by canon and cannot be changed in this project: when both places of a duplication are such texts, neither block nor note it; when the project's own text duplicates one in a line this landing added or changed, block as usual and say to keep the canon text and change the project's.";

export function duplicatePrompt(changed: readonly string[], standing: StandingText, guide: string | undefined, changedSkills: readonly { path: string; text: string }[] = [], diffs: readonly { path: string; diff: string }[] = []): string {
  const parts: string[] = [
    "You review the standing instructions of a project: text loaded into every AI coding session at start. The same requirement written in two places drifts apart, and the reader no longer knows which one holds.",
    "Block only duplication this landing introduces: one requirement (an instruction, a condition or a qualifier) is stated in two standing texts below, or twice in one of them, in any wording or language, and at least one of the two places is in a line this landing added or changed (a `+` line of the diffs below). A moved line (removed in one place, added in another) counts as added; a deleted line creates no duplication.",
    "Duplication that lies entirely in unchanged text was already there: do not block for it; you may list it as a `note`.",
    "Do not block for: a one-line pointer to where a requirement is stated; a project-specific qualifier added to a general requirement stated elsewhere; facts or descriptions that are not requirements; wording, style or formatting.",
    "Each finding names both places (file or source, and the sentence) and which one to keep.",
    "Write the findings in the language the changed text is written in.",
    // reason: same answer format as the rule review, so canon derives the verdict here too (BR-2367, D-74)
    `\`duplication\` is the only blocking criterion: a finding that matches it is given with the key \`duplication\`; every other remark (old duplication in unchanged text, a pointer, a qualifier) is given with the key \`note\`, which never blocks. ${NO_VERDICT}`,
    'Answer with JSON only: {"findings":[{"criterion":"duplication"|"note","text":"<one sentence>"}]}',
    "",
    `# Changed in this landing: ${changed.join(", ")}`,
  ];
  if (guide !== undefined) parts.push(`# canon brief workflow guide (printed at the start of every session)\n\n${guide.trim()}\n`);
  for (const f of standing.files) parts.push(`# ${f.path} (instruction file, loaded whole)\n\n${f.text.trim()}\n`);
  if (standing.skills.length) parts.push(`# Skill descriptions (each loaded into every session)\n\n${standing.skills.map((s) => `- ${s.path}: ${s.description}${s.shipped ? " (shipped by canon)" : ""}`).join("\n")}`);
  // reason: the project cannot change what canon ships, so duplication among those texts must not refuse its landing (BR-2410, #182)
  if (standing.skills.some((s) => s.shipped)) parts.push(SHIPPED_NOTE);
  // reason: the reviewer runs in main's tree (BR-2216), so a changed skill's body must travel in the prompt, or it reads main's old text (#122)
  for (const f of changedSkills) parts.push(`# ${f.path} (changed in this landing, full new text)\n\n${f.text.trim()}\n`);
  // reason: without the diff the reviewer cannot tell duplication this landing added from old duplication in the same file (BR-2143, #121)
  for (const d of diffs) parts.push(`# ${d.path} (diff of this landing, \`+\` lines are added or changed)\n\n${d.diff.trim()}\n`);
  return parts.join("\n");
}

const bytes = (text: string): number => Buffer.byteLength(text);
const kb = (n: number): string => `${Math.ceil(n / 1024)}`;

/** One call of a split review: the groups of domain text it carries, per top-level domain, and their estimated size. */
interface Call {
  readonly groups: Map<string, { readonly emitted: Set<string>; readonly blocks: string[] }>;
  size: number;
}

/** The note a call of a split review carries: which call it is and how many there are (BR-2359). */
function callNote(i: number, n: number): string {
  return `This review is split into ${n} calls because of its size; this is call ${i} of ${n}. Every call shows the same changed documents, the rule index and the accepted decisions' titles, and only part of the affected domains' text: judge what is shown, and never block because a rule or domain text is not shown in this call.`;
}

/**
 * The bytes the note adds to a call when there are at most `maxCalls` calls, joining newline included. The count is known only
 * after packing, but its digits can only be fewer than those of `maxCalls`, so the note of call `maxCalls` of `maxCalls` is the
 * largest, and reserving its measured size up front makes the estimate exact or above, never below (BR-2359, #160).
 */
function noteRoom(corpus: Corpus, maxCalls: number): number {
  const n = Math.max(2, maxCalls);
  return bytes(promptHead(corpus, [], {}, callNote(n, n)).join("\n")) - bytes(promptHead(corpus, [], {}).join("\n"));
}

/** The most calls packing the top domains can make: each call holds at least one piece, a rule or a README without rules. */
function maxCalls(root: string, corpus: Corpus, tops: readonly string[]): number {
  let n = 1;
  for (const top of tops) {
    const { ctx } = packer(root, corpus, top);
    n += ctx.domains.length + ctx.rules.length;
  }
  return n;
}

/** What every call carries apart from the changed documents and the domain text: instructions, rule index, accepted decision titles, the split note. */
function fixedBytes(corpus: Corpus, room: number): number {
  return bytes([...promptHead(corpus, [], {})].join("\n")) + bytes(promptTail(corpus).join("\n")) + room;
}

/** The pieces one top domain's text is packed from, and what a call pays for them (BR-2359). `g`: the group of this domain already in the call. */
function packer(root: string, corpus: Corpus, top: string) {
  const ctx = contextFor(corpus, top);
  const only = (d: Domain, rules: Context["rules"], withLists: boolean): Context => ({ ...ctx, domains: [d], rules, ...(withLists ? {} : { decisions: [], changes: [], extras: [], others: [] }) });
  const readme = (d: Domain): string => renderContext(root, only(d, [], d.name === top), { full: true });
  const chain = (d: Domain): Domain[] => ctx.domains.filter((x) => x.name === d.name || d.name.startsWith(`${x.name}/`));
  // what adding `rules` of `d` costs: the group header unless `g` is there, the READMEs of d and its parents not in `g` yet, the rules
  const price = (g: { readonly emitted: Set<string> } | undefined, d: Domain, rules: readonly Rule[]): number => {
    let n = g ? 0 : bytes(contextHeader(top)) + 1;
    for (const x of chain(d)) if (!g?.emitted.has(x.name)) n += bytes(readme(x)) + 1;
    for (const r of rules) n += bytes(ruleSection(r)) + 1;
    return n;
  };
  return { ctx, readme, chain, price };
}

/**
 * Whether the top domain's own README with its lists is most of a `piece` of that domain: then splitting the domain into
 * subdomains cannot shrink it, the lists stay with the top domain (BR-2359, #145).
 */
function topReadmeIsLarge(root: string, corpus: Corpus, top: string, piece: number): boolean {
  const { ctx, readme } = packer(root, corpus, top);
  const d = ctx.domains.find((x) => x.name === top);
  return d !== undefined && bytes(readme(d)) * 2 > piece;
}

/** The way out of a domain piece that is too large for `review_max_prompt_kb`, shared by the refusal and the early hint (BR-2359, #145). */
export function pieceRemedy(root: string, corpus: Corpus, need: number, piece: number, where: string): string {
  const top = where.split("/")[0]!;
  const raise = `raise review_max_prompt_kb in canon/config.yaml to at least ${kb(need)} KB`;
  if (topReadmeIsLarge(root, corpus, top, piece)) return `${raise}, or shorten the README of ${top}: it and the lists after it (decisions, changes and other documents that name ${top}'s rules) are most of the piece, and splitting ${top} into subdomains does not make them smaller`;
  return `${raise}, or split ${where} into subdomains (canon rule domain ${where}/<name>) so a piece of it is smaller`;
}

/** The bytes the changed documents (and the other per-change parts of the head) add to a prompt (BR-2359); one definition for the refusal and the size hint (BR-2375). */
export function changedBytes(corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras): number {
  const headEmpty = bytes([...promptHead(corpus, [], {})].join("\n"));
  return Math.max(0, bytes(promptHead(corpus, changed, extras).join("\n")) - headEmpty);
}

/** What to do about a smallest prompt of `need` bytes that is over `budget`, by which part is large (BR-2359, #136, #145). */
export function refusalRemedy(root: string, corpus: Corpus, s: { docs: number; index: number; piece: number; where: string | undefined; need: number; budget: number }): string {
  // reason: splitting the change only shrinks the changed documents, so it helps only when they are the largest part and the rest fits alone (BR-2359, #136)
  const splitHelps = s.docs >= s.index && s.docs >= s.piece && s.index + s.piece < s.budget;
  if (splitHelps) return "land the changed documents in several smaller changes";
  const rest = s.piece > 0 && s.where ? pieceRemedy(root, corpus, s.need, s.piece, s.where) : `raise review_max_prompt_kb in canon/config.yaml to at least ${kb(s.need)} KB`;
  return `splitting the change cannot help, the changed documents are not what makes it too large: ${rest}`;
}

/** One top domain's smallest piece the rule review can be given, with the fixed part it comes with (BR-2359, #145). */
export interface DomainPiece {
  readonly top: string;
  /** The (sub)domain whose piece it is, the one to split. */
  readonly where: string;
  /** Bytes of the piece: its README chain and its largest rule. */
  readonly piece: number;
}

/**
 * The size of the smallest review piece of every top domain, for a warning before a change is refused: the same prices
 * `reviewPrompts` packs with. `fixed` is what every call carries besides the changed documents, which are not known without a change.
 */
export function reviewSizes(root: string, corpus: Corpus): { readonly fixed: number; readonly pieces: readonly DomainPiece[] } {
  const pieces: DomainPiece[] = [];
  for (const top of corpus.domains.filter((d) => !d.parent).map((d) => d.name)) {
    const { ctx, price } = packer(root, corpus, top);
    let worst: DomainPiece | undefined;
    for (const d of ctx.domains) {
      const rules = ctx.rules.filter((r) => r.domain === d.name);
      // reason: a subdomain that does not fit whole is packed one rule at a time, so the piece that must fit is its largest rule with the READMEs above it (BR-2359)
      const alone = rules.length ? rules.map((r) => price(undefined, d, [r])) : [price(undefined, d, [])];
      const piece = Math.max(...alone);
      if (!worst || piece > worst.piece) worst = { top, where: d.name, piece };
    }
    if (worst) pieces.push(worst);
  }
  const tops = corpus.domains.filter((d) => !d.parent).map((d) => d.name);
  return { fixed: fixedBytes(corpus, noteRoom(corpus, maxCalls(root, corpus, tops))), pieces };
}

/**
 * The prompts one rule review is made of (BR-2359, D-67). Everything fits in `budgetBytes`: one prompt, exactly what
 * `reviewPrompt` gives. Otherwise every call carries the changed documents, the rule index and the accepted decisions'
 * titles, plus the affected domains' text packed by subdomain; a fixed part that alone is over budget is an error.
 */
export function reviewPrompts(root: string, corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras, budgetBytes: number): Result<readonly string[]> {
  const whole = reviewPrompt(root, corpus, changed, extras);
  if (bytes(whole) <= budgetBytes) return ok([whole]);

  const tail = promptTail(corpus);
  const noWording: ReviewExtras = { ...extras, wording: [] };
  const room = noteRoom(corpus, maxCalls(root, corpus, contextTops(corpus, changed, extras)));
  const fixed = (first: boolean): number => bytes([...promptHead(corpus, changed, first ? extras : noWording), ...tail].join("\n")) + room;
  // the three parts of the smallest prompt, so a refusal can say which one is too large (BR-2359, D-67, #136)
  const docsBytes = changedBytes(corpus, changed, extras);
  const indexBytes = fixedBytes(corpus, room);
  /** `piece`: the domain text the smallest call needs on top of the fixed parts, `where`: the domain to split when that is the large part. */
  const tooBig = (need: number, what: string, piece = 0, where?: string): Result<never> => {
    const sizes = `changed documents ${kb(docsBytes)} KB, review instructions + rule index + accepted decision titles ${kb(indexBytes)} KB, domain text ${kb(piece)} KB`;
    const remedy = refusalRemedy(root, corpus, { docs: docsBytes, index: indexBytes, piece, where, need, budget: budgetBytes });
    return err("invalid", `the rule review prompt cannot be made smaller than ${kb(need)} KB (${what}), above review_max_prompt_kb = ${kb(budgetBytes)} KB; sizes: ${sizes}: ${remedy}`);
  };
  if (fixed(true) > budgetBytes) return tooBig(fixed(true), "the changed documents, the rule index and the accepted decisions' titles, which every call carries");

  const calls: Call[] = [];
  let cur: Call = { groups: new Map(), size: 0 };
  calls.push(cur);
  const fixedRest = fixed(false);
  const roomOf = (c: Call): number => (c === calls[0] ? budgetBytes - fixed(true) : budgetBytes - fixedRest);

  for (const top of contextTops(corpus, changed, extras)) {
    const { ctx, readme, chain, price: priceIn } = packer(root, corpus, top);
    const price = (call: Call, d: Domain, rules: readonly Rule[]): number => priceIn(call.groups.get(top), d, rules);
    const add = (call: Call, d: Domain, rules: readonly Rule[]): void => {
      call.size += price(call, d, rules);
      let g = call.groups.get(top);
      if (!g) call.groups.set(top, (g = { emitted: new Set(), blocks: [] }));
      for (const x of chain(d)) {
        if (g.emitted.has(x.name)) continue;
        g.emitted.add(x.name);
        g.blocks.push(readme(x));
      }
      for (const r of rules) g.blocks.push(ruleSection(r));
    };
    const empty = (): Call => ({ groups: new Map(), size: 0 });
    for (const d of ctx.domains) {
      const rules = ctx.rules.filter((r) => r.domain === d.name);
      if (price(cur, d, rules) <= roomOf(cur) - cur.size) {
        add(cur, d, rules);
        continue;
      }
      // a subdomain goes whole into the next call when it fits there, one rule at a time only when it fits nowhere
      const next = empty();
      if (cur.size > 0 && price(next, d, rules) <= budgetBytes - fixedRest) {
        calls.push((cur = next));
        add(cur, d, rules);
        continue;
      }
      if (rules.length === 0) return tooBig(price(next, d, rules) + fixedRest, `the README of ${d.name}`, price(next, d, rules), d.name);
      for (const r of rules) {
        if (price(cur, d, [r]) > roomOf(cur) - cur.size) {
          if (cur.size > 0) calls.push((cur = empty()));
          const need = price(cur, d, [r]) + (budgetBytes - roomOf(cur));
          if (need > budgetBytes) return tooBig(need, `${r.id} with the domain texts above it, the smallest piece of ${top} the review can be given`, price(cur, d, [r]), d.name);
        }
        add(cur, d, [r]);
      }
    }
  }

  const prompts = calls.map((call, i) => {
    const note = calls.length > 1 ? callNote(i + 1, calls.length) : undefined;
    const groups = [...call.groups].map(([top, g]) => `${contextHeader(top)}${g.blocks.join("\n")}`);
    return [...promptHead(corpus, changed, i === 0 ? extras : noWording, note), ...groups, ...tail].join("\n");
  });
  const worst = Math.max(...prompts.map(bytes));
  // reason: every piece fits and the note room is its measured size, so this is a defect of the packer, not something raising the budget fixes (BR-2359, #160)
  if (worst > budgetBytes) throw new Error(`canon bug: a call of the split rule review is ${worst} bytes, above review_max_prompt_kb = ${kb(budgetBytes)} KB (${budgetBytes} bytes) although every piece fits; report it with the change that was reviewed (#160)`);
  return ok(prompts);
}

/** The prompts of a review whose changed documents may be split into parts, and the documents each part shows in full (BR-2448). */
export interface PartedPrompts {
  readonly prompts: readonly string[];
  /** One entry per part; a single entry with every changed document when the review was not split by documents. */
  readonly parts: readonly (readonly Doc[])[];
}

/**
 * The prompts of a review after landing (BR-2448): `reviewPrompts` when it can make them; otherwise, when the changed documents
 * are what does not fit, they are split into parts, in order of their domain, each part as many documents as fit with the
 * fixed part and the largest domain piece it needs, and each part reviewed as `reviewPrompts` reviews (BR-2359). Every part
 * lists the other changed documents by id, title and first line; the deleted documents, the domain READMEs, the change's lessons and
 * the wording judgements go with the first part; the overview with every part. A single changed document that does not fit is the
 * error `reviewPrompts` gives for it alone.
 */
export function reviewPromptParts(root: string, corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras, budgetBytes: number): Result<PartedPrompts> {
  const whole = reviewPrompts(root, corpus, changed, extras, budgetBytes);
  if (whole.ok) return ok({ prompts: whole.value, parts: [changed] });
  if (changed.length < 2) return whole;
  const pieces = new Map(reviewSizes(root, corpus).pieces.map((p) => [p.top, p.piece]));
  const tail = bytes(promptTail(corpus).join("\n"));
  // reason: the documents of one domain go together, so a contradiction between them is seen whole in one part (BR-2448)
  const key = (d: Doc): string => (d.kind === "rule" ? `0 ${d.domain}` : `1 ${d.kind}`);
  const order = [...changed].sort((a, b) => key(a).localeCompare(key(b)));
  const extrasOf = (docs: readonly Doc[], i: number, n: number): ReviewExtras => {
    const ids = new Set(docs.map((d) => d.id));
    const mine = new Set(docs);
    const others = order.filter((d) => !mine.has(d));
    return {
      ...(i === 1 ? extras : { change: undefined, wording: [] }),
      ...(extras.architecture ? { architecture: extras.architecture } : {}),
      added: (extras.added ?? []).filter((a) => ids.has(a.id)),
      restatements: (extras.restatements ?? []).filter((r) => ids.has(r.id)),
      part: { i, n, others },
    };
  };
  // the smallest prompt a part can have: its head with the most digits a part number can have, the tail, the split note's room and its largest domain piece
  const fits = (docs: readonly Doc[], i: number): boolean => {
    const ex = extrasOf(docs, i, changed.length);
    const tops = contextTops(corpus, docs, ex);
    const piece = Math.max(0, ...tops.map((t) => pieces.get(t) ?? 0));
    return bytes(promptHead(corpus, docs, ex).join("\n")) + tail + noteRoom(corpus, maxCalls(root, corpus, tops)) + piece + 2 <= budgetBytes;
  };
  const groups: Doc[][] = [];
  let cur: Doc[] = [];
  for (const d of order) {
    if (fits([...cur, d], groups.length + 1)) {
      cur.push(d);
      continue;
    }
    if (cur.length > 0) groups.push(cur);
    cur = [d];
    if (fits(cur, groups.length + 1)) continue;
    // reason: one changed document that does not fit even alone cannot be split further; the error is the one its own review gives (BR-2448, BR-2359)
    const alone = reviewPrompts(root, corpus, cur, extrasOf(cur, groups.length + 1, changed.length), budgetBytes);
    if (!alone.ok) return alone;
  }
  groups.push(cur);
  const prompts: string[] = [];
  for (const [i, g] of groups.entries()) {
    const r = reviewPrompts(root, corpus, g, extrasOf(g, i + 1, groups.length), budgetBytes);
    if (!r.ok) return r;
    prompts.push(...r.value);
  }
  return ok({ prompts, parts: groups });
}

/** The line a review split by its changed documents prints: how many parts and which documents each shows in full (BR-2448). */
export function partsNote(parts: readonly (readonly Doc[])[]): string | undefined {
  return parts.length > 1 ? `the changed documents do not fit one call, so they are reviewed in ${parts.length} parts: ${parts.map((p, i) => `${i + 1}: ${p.map((d) => d.id).join(", ")}`).join("; ")}` : undefined;
}

/** `Ncalls` sizes line for the landing output, e.g. `2 calls by size (review_max_prompt_kb): 1: 241 KB, 2: 224 KB`; undefined for a single call. */
export function splitNote(prompts: readonly string[]): string | undefined {
  return prompts.length > 1 ? `split into ${prompts.length} calls by size (review_max_prompt_kb): ${prompts.map((p, i) => `${i + 1}: ${kb(bytes(p))} KB`).join(", ")}` : undefined;
}

/**
 * Runs the calls of one review, at most `parallel` at a time, and merges their verdicts (BR-2359, D-67, D-83): `block` if any
 * call blocked, the findings of all calls in call order without repeats, the wording answers of the first call. A call that
 * fails ends the review at once: the calls still running are stopped and no other starts (BR-2216).
 */
export async function runReviews(command: string, cwd: string, prompts: readonly string[], limits: ReviewLimits, parallel = 1, parse: AnswerParser = parseAnswer): Promise<Result<ReviewVerdict>> {
  const results: (ReviewVerdict | undefined)[] = prompts.map(() => undefined);
  const running = new Set<{ kill(): void }>();
  let failed: Result<never> | undefined;
  const stopAll = (): void => {
    for (const r of running) r.kill();
  };
  limits.track?.({ kill: stopAll });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failed === undefined && next < prompts.length) {
      const i = next++;
      let mine: { kill(): void } | undefined;
      const track = (r: { kill(): void } | undefined): void => {
        if (r) running.add((mine = r));
        else if (mine) running.delete(mine);
      };
      const one = await runReview(command, cwd, prompts[i]!, { ...limits, track }, parse);
      if (!one.ok) {
        // reason: the first failure is the one reported; the calls it stops fail too, only because they were stopped (BR-2216)
        if (failed === undefined) {
          failed = one;
          stopAll();
        }
        return;
      }
      results[i] = one.value;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, prompts.length)) }, worker));
  } finally {
    limits.track?.(undefined);
  }
  if (failed !== undefined) return failed;
  const all = results as ReviewVerdict[];
  const first = all[0]!;
  return ok({ verdict: all.some((x) => x.verdict === "block") ? "block" : "ok", findings: [...new Set(all.flatMap((x) => x.findings))], ...(first.wording ? { wording: first.wording } : {}) });
}
