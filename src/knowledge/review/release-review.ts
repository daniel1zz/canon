import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { DUPLICATE_CRITERIA, NO_VERDICT, parseAnswer, runReviews, type AnswerParser, type ReviewLimits, type ReviewVerdict } from "./review.ts";
import { run, LABEL } from "./code-review.ts";
import { addedLines } from "../check/restatement/restatement.ts";

/**
 * The release check of canon's own repository (BR-2411, D-91): before a build is published, the standing text canon ships to
 * every project (each `canon-*` skill's SKILL.md and the workflow guide) is reviewed for duplication all together, in full.
 * A landing's duplicate review sees only the texts it changed in full (BR-2143) and a downstream landing skips them
 * (BR-2410), so this is the one place where two shipped texts are compared whole.
 */
export interface ShippedText {
  readonly path: string;
  readonly text: string;
}

/**
 * What the last release shipped (D-107): its commit, each skill's text there (absent: the skill is new) and the workflow guide
 * it recorded (absent: the whole guide counts as changed).
 */
export interface Baseline {
  readonly commit: string;
  readonly texts: ReadonlyMap<string, string>;
  readonly guide?: string | undefined;
}

/** The name a finding uses for the workflow guide in its `places`. */
export const GUIDE_PLACE = "guide";

const PREFIX = "canon-";

/** Every `canon-*` skill's SKILL.md under `<root>/.claude/skills`, by directory name. */
export function shippedTexts(root: string): ShippedText[] {
  const dir = join(root, ".claude", "skills");
  const out: ShippedText[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = `.claude/skills/${name}/SKILL.md`;
    if (name.startsWith(PREFIX) && existsSync(join(root, path))) out.push({ path, text: readFileSync(join(root, path), "utf8") });
  }
  return out;
}

/**
 * The last release as the baseline (D-107): the commit `<primary>/dist/skills` links to (BR-2412), each shipped skill's text
 * there, and the guide that release recorded (`guideOf`). Absent when nothing was released; an error when the linked commit
 * cannot be read, never a silent full review.
 */
export function loadBaseline(cwd: string, primary: string, texts: readonly ShippedText[], guideOf: (commit: string) => string | undefined): Result<Baseline | undefined> {
  const link = join(primary, "dist", "skills");
  let target: string;
  try {
    if (!lstatSync(link).isSymbolicLink()) return err("io", `${link} is not a symbolic link (BR-2412), so the last release is unknown`);
    target = readlinkSync(link);
  } catch {
    return ok(undefined);
  }
  const m = /^skills-([0-9a-f]{40})$/.exec(target);
  if (!m) return err("io", `${link} points to ${target}, not skills-<commit> (BR-2412), so the last release is unknown`);
  const commit = m[1]!;
  const there = git(cwd, "cat-file", "-e", `${commit}^{commit}`);
  if (!there.ok) return err("io", `the last release ${commit.slice(0, 9)} (${link}) is not in this repository: ${there.error.message}`);
  const old = new Map<string, string>();
  for (const t of texts) {
    // reason: a skill the release did not have is new, all of its lines changed; `git show` fails only for that once the commit exists
    const r = Bun.spawnSync(["git", "show", `${commit}:${t.path}`], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) old.set(t.path, r.stdout.toString());
  }
  return ok({ commit, texts: old, guide: guideOf(commit) });
}

/** What identifies one set of shipped texts: the same texts and guide always give the same hash. */
export function releaseHash(texts: readonly ShippedText[], guide: string, baseline?: string): string {
  const h = createHash("sha256");
  // reason: which findings block depends on the baseline as well as the texts, so a verdict is reused only with the same one (D-107)
  if (baseline !== undefined) h.update(`baseline\0${baseline}\0`);
  h.update(`guide\0${guide}\0`);
  for (const t of texts) h.update(`${t.path}\0${t.text}\0`);
  return h.digest("hex");
}

const bytes = (text: string): number => Buffer.byteLength(text);
const kb = (n: number): string => `${Math.ceil(n / 1024)}`;

function header(): string[] {
  return [
    "You review the standing instructions canon ships into every project that uses it: its workflow guide (printed at the start of every session) and its skills, all given below in full. A project cannot change these texts, so a requirement written in two of them stays duplicated in every project, and a project's own duplicate review cannot resolve it.",
    "Block any requirement (an instruction, a condition or a qualifier) stated in two of the texts below, or twice in one of them, in any wording or language.",
    "Do not block for: a one-line pointer to where a requirement is stated; a skill-specific qualifier added to a general requirement stated elsewhere; facts or descriptions that are not requirements; wording, style or formatting.",
    "Each finding names both places (file and sentence) and which one to keep.",
    // reason: canon, not the reviewer, decides whether a duplicate touches text changed since the last release, from the quotes (D-107)
    `A \`duplication\` finding also lists every place it names under \`places\`: the file path as given in its heading (\`${GUIDE_PLACE}\` for the workflow guide) and a quote copied exactly from that text, one sentence or less. A duplicate lying entirely in lines that are not listed under its text's \"Lines added or changed since the last release\" was already shipped and does not block; canon reads that from the quotes, so quote the duplicated words themselves.`,
    "Write the findings in English.",
    `\`duplication\` is the only blocking criterion: a finding that matches it is given with the key \`duplication\`; every other remark is given with the key \`note\`, which never blocks. ${NO_VERDICT}`,
    `Answer with JSON only: {"findings":[{"criterion":${DUPLICATE_CRITERIA.map((c) => `"${c}"`).join("|")}|"note","text":"<one sentence>","places":[{"file":"<path or ${GUIDE_PLACE}>","quote":"<exact words>"}]}]}`,
  ];
}

/** The lines of `text` (1-based) added or changed since the baseline; every line when the baseline does not have it (D-107). */
export function changedSince(text: string, before: string | undefined): Set<number> {
  return addedLines(text, before);
}

function changedList(name: string, text: string, before: string | undefined, baseline: Baseline | undefined): string {
  const head = `Lines added or changed since the last release in ${name}`;
  if (before === undefined) return `${head}: all of them (${baseline ? `not in the release ${baseline.commit.slice(0, 9)}` : "there is no earlier release"}).\n`;
  const lines = text.split("\n");
  const changed = [...changedSince(text, before)].filter((n) => lines[n - 1]!.trim() !== "");
  if (changed.length === 0) return `${head}: none.\n`;
  return `${head} (line number, then the line):\n${changed.map((n) => `${n}: ${lines[n - 1]}`).join("\n")}\n`;
}

const textBlock = (t: ShippedText, baseline: Baseline | undefined): string =>
  `# ${t.path} (shipped by canon, full text)\n\n${t.text}${t.text.endsWith("\n") ? "" : "\n"}\n${changedList(t.path, t.text, baseline?.texts.get(t.path), baseline)}`;

/**
 * The prompts of the release check (BR-2411). All in one call when it fits `budgetBytes`; otherwise the skills are packed into
 * chunks of at most half the room left after the fixed part, and each call carries the header, the guide and two chunks, one
 * call per pair of chunks, so every two skills meet in at least one call. Refused, with the sizes, when the largest skill is
 * over that half.
 */
export function releasePrompts(texts: readonly ShippedText[], guide: string, budgetBytes: number, baseline?: Baseline): Result<readonly string[]> {
  const guideBlock = `# ${GUIDE_PLACE}: canon brief workflow guide (shipped by canon, printed at the start of every session)\n\n${guide}${guide.endsWith("\n") ? "" : "\n"}\n${changedList(GUIDE_PLACE, guide, baseline?.guide, baseline)}`;
  const block = (t: ShippedText) => textBlock(t, baseline);
  const whole = [...header(), "", guideBlock, ...texts.map(block)].join("\n");
  if (bytes(whole) <= budgetBytes) return ok([whole]);
  // reason: the split note grows with the number of calls; reserve its longest form so no call goes over the budget (BR-2359)
  const note = (i: number, n: number) => `This is call ${i} of ${n}: it holds the guide and some of the skills; the other calls hold the rest. Judge only duplication among the texts in this call.`;
  const fixed = bytes([...header(), note(9999, 9999), "", guideBlock].join("\n")) + 2;
  const blocks = texts.map(block);
  // reason: a chunk holds at most half of what is left after the fixed part, so a skill over that half fits in no chunk (BR-2411)
  const largest = Math.max(...blocks.map((b) => bytes(b) + 1));
  const need = fixed + 2 * largest;
  if (need > budgetBytes) {
    return err("invalid", `the release check needs ${kb(need)} KB in one call (header and guide ${kb(fixed)} KB, twice the largest skill ${kb(2 * largest)} KB) and review_max_prompt_kb is ${kb(budgetBytes)} KB: raise review_max_prompt_kb to at least ${kb(need)}, or shorten the largest skill`);
  }
  const room = Math.floor((budgetBytes - fixed) / 2);
  const chunks: string[][] = [];
  let size = 0;
  for (const b of blocks) {
    const n = bytes(b) + 1;
    if (chunks.length === 0 || size + n > room) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1]!.push(b);
    size += n;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < chunks.length; i++) for (let j = i + 1; j < chunks.length; j++) pairs.push([i, j]);
  if (pairs.length === 0) pairs.push([0, 0]);
  return ok(pairs.map(([i, j], k) => [...header(), note(k + 1, pairs.length), "", guideBlock, ...chunks[i]!, ...(i === j ? [] : chunks[j]!)].join("\n")));
}

/** `text` with every run of whitespace made one space, and for each character of the result where it came from in `text`. */
function squeeze(text: string): { flat: string; from: number[] } {
  let flat = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      if (flat.endsWith(" ") || flat === "") continue;
      flat += " ";
    } else flat += text[i]!;
    from.push(i);
  }
  return { flat, from };
}

/**
 * Whether `quote` is found in `text` and every place it is found lies in lines not in `changed` (D-107). Whitespace is
 * compared as one space, since a reviewer copies a sentence that wraps across lines; a quote not found is not old.
 */
export function quoteIsOld(text: string, quote: string, changed: ReadonlySet<number>): boolean {
  const q = quote.trim().replace(/\s+/g, " ");
  if (q === "") return false;
  const { flat, from } = squeeze(text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  let found = false;
  for (let at = flat.indexOf(q); at !== -1; at = flat.indexOf(q, at + 1)) {
    found = true;
    for (let n = lineOf(from[at]!); n <= lineOf(from[at + q.length - 1]!); n++) if (changed.has(n)) return false;
  }
  return found;
}

const ALREADY = "(already released) ";

/**
 * The release check's answer parser (BR-2411, D-107): a `duplication` finding whose every place is quoted from text the last
 * release already shipped becomes a note; one that touches a changed line, has no places or quotes words not found still blocks.
 */
export function releaseParser(texts: readonly ShippedText[], guide: string, baseline: Baseline | undefined): AnswerParser {
  const sources = new Map<string, { text: string; changed: Set<number> }>();
  for (const t of texts) sources.set(t.path, { text: t.text, changed: changedSince(t.text, baseline?.texts.get(t.path)) });
  sources.set(GUIDE_PLACE, { text: guide, changed: changedSince(guide, baseline?.guide) });
  const old = (places: unknown): boolean => {
    if (!Array.isArray(places) || places.length === 0) return false;
    return places.every((p) => {
      const { file, quote } = (p !== null && typeof p === "object" ? p : {}) as { file?: unknown; quote?: unknown };
      const source = typeof file === "string" ? sources.get(file.replace(/^\.\//, "")) : undefined;
      return source !== undefined && typeof quote === "string" && quoteIsOld(source.text, quote, source.changed);
    });
  };
  return (answer) => {
    const parsed = parseAnswer(answer);
    if (!parsed.ok) return parsed;
    const list = (answer as { findings?: unknown }).findings;
    // reason: an answer without finding objects carries no places, so nothing in it can be shown to be old (D-107)
    if (!Array.isArray(list) || !list.every((f) => f !== null && typeof f === "object")) return parsed;
    let blocking = false;
    const findings = list.map((f, i) => {
      const { criterion, text, places } = f as { criterion?: unknown; text?: unknown; places?: unknown };
      if (criterion === "note") return parsed.value.findings[i]!;
      if (old(places)) return `${ALREADY}${String(text)}`;
      blocking = true;
      return parsed.value.findings[i]!;
    });
    return ok({ verdict: blocking ? "block" : "ok", findings });
  };
}

/** One earlier verdict on the same texts, so the paid review runs once per set of texts (BR-2411). */
export interface EarlierVerdict {
  readonly verdict: "ok" | "block";
  readonly findings: readonly string[];
}

export interface ReleaseCheckEnv {
  readonly cwd: string;
  readonly reviewer: string;
  readonly limits: ReviewLimits;
  readonly budgetBytes: number;
  readonly parallel: number;
  readonly guide: string;
  /** What the last release shipped; absent when nothing was released yet (D-107). */
  readonly baseline?: Baseline | undefined;
  /** The verdict an earlier release check gave these texts, by hash. */
  readonly earlier: (hash: string) => EarlierVerdict | undefined;
  /** Records a verdict this check got from the review command. */
  readonly record: (hash: string, verdict: ReviewVerdict) => void;
}

export interface ReleaseCheck {
  readonly hash: string;
  readonly verdict: "ok" | "block";
  readonly findings: readonly string[];
  /** True when an earlier verdict on the same texts was used and the review command did not run. */
  readonly reused: boolean;
  /** True when the texts are exactly the last release's: nothing changed can repeat anything, the review command did not run (D-107). */
  readonly unchanged?: boolean;
  readonly calls: number;
}

/** Reviews every shipped text together, or reuses the verdict an earlier check gave the same texts (BR-2411). */
export async function releaseCheck(e: ReleaseCheckEnv): Promise<Result<ReleaseCheck>> {
  const texts = shippedTexts(e.cwd);
  if (texts.length === 0) return err("io", `no canon-* skill under ${join(e.cwd, ".claude", "skills")}`);
  const hash = releaseHash(texts, e.guide, e.baseline?.commit);
  const b = e.baseline;
  // reason: with no changed line no duplicate can block (D-107), so the paid review is not run
  if (b && b.guide === e.guide && texts.every((t) => b.texts.get(t.path) === t.text)) return ok({ hash, verdict: "ok", findings: [], reused: false, unchanged: true, calls: 0 });
  const earlier = e.earlier(hash);
  if (earlier) return ok({ hash, verdict: earlier.verdict, findings: earlier.findings, reused: true, calls: 0 });
  const prompts = releasePrompts(texts, e.guide, e.budgetBytes, e.baseline);
  if (!prompts.ok) return prompts;
  const v = await runReviews(e.reviewer, e.cwd, prompts.value, e.limits, e.parallel, releaseParser(texts, e.guide, e.baseline));
  if (!v.ok) return v;
  e.record(hash, v.value);
  return ok({ hash, verdict: v.value.verdict, findings: v.value.findings, reused: false, calls: prompts.value.length });
}

export const RELEASE_ISSUE_TITLE = "Release check: canon's shipped skills repeat a requirement";

/**
 * Names the block on GitHub the way the post-land code review does (BR-2072): a comment on the open `canon-review` issue with
 * this title, else a new issue with it. Returns the issue's URL or number.
 */
export function reportBlock(cwd: string, gh: string, green: string, findings: readonly string[]): Result<string> {
  const list = run(gh, ["issue", "list", "--state", "open", "--label", LABEL, "--search", `"${RELEASE_ISSUE_TITLE}" in:title`, "--json", "number,title"], cwd);
  if (!list.ok) return list;
  const open = (JSON.parse(list.value || "[]") as { number: number; title: string }[]).find((i) => i.title === RELEASE_ISSUE_TITLE);
  const body = [
    `The release check of \`${green.slice(0, 9)}\` blocked: \`dist/canon\` and \`dist/skills\` were not published and still hold the previous release.`,
    "",
    ...findings.map((f) => `- ${f}`),
    "",
    `Reproduce: in a checkout of \`${green.slice(0, 9)}\`, \`bun scripts/release.ts --check\`. Fix the skill text in a change; the next green commit publishes.`,
  ].join("\n");
  if (open) {
    const c = run(gh, ["issue", "comment", String(open.number), "--body", body], cwd);
    return c.ok ? ok(`#${open.number}`) : c;
  }
  const c = run(gh, ["issue", "create", "--title", RELEASE_ISSUE_TITLE, "--label", LABEL, "--body", body], cwd);
  return c.ok ? ok(c.value.trim()) : c;
}
