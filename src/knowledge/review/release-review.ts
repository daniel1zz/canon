import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";
import { DUPLICATE_CRITERIA, NO_VERDICT, runReviews, type ReviewLimits, type ReviewVerdict } from "./review.ts";
import { run, LABEL } from "./code-review.ts";

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

/** What identifies one set of shipped texts: the same texts and guide always give the same hash. */
export function releaseHash(texts: readonly ShippedText[], guide: string): string {
  const h = createHash("sha256");
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
    "Write the findings in English.",
    `\`duplication\` is the only blocking criterion: a finding that matches it is given with the key \`duplication\`; every other remark is given with the key \`note\`, which never blocks. ${NO_VERDICT}`,
    `Answer with JSON only: {"findings":[{"criterion":${DUPLICATE_CRITERIA.map((c) => `"${c}"`).join("|")}|"note","text":"<one sentence>"}]}`,
  ];
}

const textBlock = (t: ShippedText): string => `# ${t.path} (shipped by canon, full text)\n\n${t.text.trim()}\n`;

/**
 * The prompts of the release check (BR-2411). All in one call when it fits `budgetBytes`; otherwise the skills are packed into
 * chunks and each call carries the header, the guide and two chunks, one call per pair of chunks, so every two skills meet in
 * at least one call. Refused, with the sizes, when one call cannot hold the fixed part and two of the largest skills.
 */
export function releasePrompts(texts: readonly ShippedText[], guide: string, budgetBytes: number): Result<readonly string[]> {
  const guideBlock = `# canon brief workflow guide (shipped by canon, printed at the start of every session)\n\n${guide.trim()}\n`;
  const whole = [...header(), "", guideBlock, ...texts.map(textBlock)].join("\n");
  if (bytes(whole) <= budgetBytes) return ok([whole]);
  // reason: the split note grows with the number of calls; reserve its longest form so no call goes over the budget (BR-2359)
  const note = (i: number, n: number) => `This is call ${i} of ${n}: it holds the guide and some of the skills; the other calls hold the rest. Judge only duplication among the texts in this call.`;
  const fixed = bytes([...header(), note(9999, 9999), "", guideBlock].join("\n")) + 2;
  const blocks = texts.map(textBlock);
  const largest = [...blocks].map(bytes).sort((a, b) => b - a);
  const need = fixed + (largest[0] ?? 0) + (largest[1] ?? 0);
  if (need > budgetBytes) {
    return err("invalid", `the release check needs ${kb(need)} KB in one call (header and guide ${kb(fixed)} KB, the two largest skills ${kb((largest[0] ?? 0) + (largest[1] ?? 0))} KB) and review_max_prompt_kb is ${kb(budgetBytes)} KB: raise review_max_prompt_kb to at least ${kb(need)}, or shorten the largest skill`);
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
  readonly calls: number;
}

/** Reviews every shipped text together, or reuses the verdict an earlier check gave the same texts (BR-2411). */
export async function releaseCheck(e: ReleaseCheckEnv): Promise<Result<ReleaseCheck>> {
  const texts = shippedTexts(e.cwd);
  if (texts.length === 0) return err("io", `no canon-* skill under ${join(e.cwd, ".claude", "skills")}`);
  const hash = releaseHash(texts, e.guide);
  const earlier = e.earlier(hash);
  if (earlier) return ok({ hash, verdict: earlier.verdict, findings: earlier.findings, reused: true, calls: 0 });
  const prompts = releasePrompts(texts, e.guide, e.budgetBytes);
  if (!prompts.ok) return prompts;
  const v = await runReviews(e.reviewer, e.cwd, prompts.value, e.limits, e.parallel);
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
