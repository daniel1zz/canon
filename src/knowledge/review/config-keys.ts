import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, MINUTE, optionalString, positiveNumber, positiveValue, REL_DIR, relPath } from "../../invocation/key.ts";

/** The `review` value that turns the rule and duplicate reviews off on purpose; unset refuses instead (BR-2074, D-51). */
export const REVIEW_NONE = "none";

/** The command an unset `review` should become, as `canon init` writes it (BR-2032) and the refusal suggests (BR-2074). */
export const DEFAULT_REVIEW = "claude -p --model sonnet --output-format text";

/** How to set a reviewer, first; then that turning the review off is the owner's call, landed by itself (BR-2074, BR-2295, D-51). */
export const REVIEW_WAYS_OUT = [
  `  set a reviewer in canon/config.yaml, a command that reads the review prompt on stdin and prints the verdict JSON on stdout: review: "${DEFAULT_REVIEW}"`,
  `  review: ${REVIEW_NONE} turns the review off: ask the owner first with canon human ask (canon does not check who sets it), and with their yes land that canon/config.yaml change as a change of its own`,
];

/**
 * The `review` value: null, empty and whitespace-only mean unset; exactly `none` is the opt-out; anything that trims and
 * case-folds to `none` but is not exactly it is a likely typo and a config error, so it is never read as a command (BR-2045).
 */
export function readReview(v: unknown): Result<string | undefined> {
  if (v === null) return ok(undefined);
  if (typeof v !== "string") return err("invalid", "`review` must be a string");
  if (v.trim() === "") return ok(undefined);
  if (v !== REVIEW_NONE && v.trim().toLowerCase() === REVIEW_NONE) return err("invalid", `\`review\` is ${JSON.stringify(v)}: to turn the review off write exactly \`review: ${REVIEW_NONE}\` (lower case, no spaces)`);
  return ok(v);
}

/** canon/config.yaml keys of the rule review and the duplicate review (C-135). */
export const reviewKeys = {
  review: configKey<string | undefined>({
    key: "review",
    doc: `Reviewer for rule and decision text and for standing instructions, the built-in first \`before_land\` step (D-3). Receives the review prompt on stdin, and in \`CANON_REVIEW_KIND\` \`land\` when a landing runs it or \`preview\` when \`canon work review\` does (BR-2366), and prints JSON \`{"findings":[{"criterion":"<criterion key the prompt lists>|note","text":"..."}]}\`: canon derives the verdict, which is block when a finding names a criterion (BR-2367); the older \`{"verdict":"ok"|"block","findings":["..."]}\` is still read as given. Unset refuses a landing that changes them (BR-2074); \`${REVIEW_NONE}\` skips the reviews on purpose (D-51).`,
    default: undefined,
    schema: optionalString,
    read: readReview,
    // reason: `none` is the opt-out, not a program to look up (BR-2074)
    commands: (v) => (v === undefined || v === REVIEW_NONE ? [] : [v]),
    listed: 60,
    checked: 40,
  }),
  reviewTimeoutMs: configKey<number>({
    key: "review_timeout_minutes",
    doc: "How long one run of the `review` command may take before canon stops it and its children and refuses the landing (BR-2296).",
    default: 20 * MINUTE,
    schema: positiveNumber(20),
    read: positiveValue("review_timeout_minutes", MINUTE),
    listed: 65,
    checked: 45,
  }),
  reviewMaxPromptBytes: configKey<number>({
    key: "review_max_prompt_kb",
    doc: "The most kilobytes (UTF-8) one run of the rule review's prompt may have; a larger review is split by subdomain into several runs of the `review` command, each with every changed document, and their findings are merged (BR-2359, D-67). The fixed part alone above it refuses the landing.",
    default: 250 * 1024,
    schema: positiveNumber(250),
    read: positiveValue("review_max_prompt_kb", 1024),
    listed: 66,
    checked: 46,
  }),
  instructions: configKey<readonly string[]>({
    key: "instructions",
    doc: "Repo-relative files every session reads at start; changing one triggers the duplicate review (BR-2143).",
    default: ["CLAUDE.md"],
    schema: { type: "array", items: relPath, default: ["CLAUDE.md"] },
    read: (v) =>
      !Array.isArray(v) || v.some((t) => typeof t !== "string" || !REL_DIR.test(t))
        ? err("invalid", "`instructions` must be a list of file paths relative to the repository root, such as CLAUDE.md")
        : ok(v as string[]),
    listed: 170,
    checked: 90,
  }),
  reviewMaxUnreviewed: configKey<number>({
    key: "review_max_unreviewed",
    doc: "The post-land code review (`scripts/code-review.ts`) reviews the landings since the last review in one batch once this many are waiting (D-59, BR-2314); 1 reviews every landing.",
    default: 10,
    schema: { type: "integer", minimum: 1, default: 10 },
    read: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`review_max_unreviewed` must be a whole number of at least 1")),
    listed: 171,
    checked: 91,
  }),
  reviewMaxAgeMs: configKey<number>({
    key: "review_max_age_minutes",
    doc: "The post-land code review also runs once the oldest landing not reviewed yet is this many minutes old (D-59, BR-2314); 0 reviews at once.",
    default: 60 * MINUTE,
    schema: { type: "number", minimum: 0, default: 60 },
    read: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? ok(v * MINUTE) : err("invalid", "`review_max_age_minutes` must be a number of minutes, 0 or more")),
    listed: 172,
    checked: 92,
  }),
};
