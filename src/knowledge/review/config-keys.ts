import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, MINUTE, optionalString, positiveNumber, positiveValue, REL_DIR, relPath } from "../../config/key.ts";

/** The `review` value that turns the rule and duplicate reviews off on purpose; unset refuses instead (BR-2074, D-51). */
export const REVIEW_NONE = "none";

/** The command an unset `review` should become, as `canon init` writes it (BR-2032) and the refusal suggests (BR-2074). */
export const DEFAULT_REVIEW = "claude -p --output-format text";

/** How to set a reviewer, first; then that turning the review off is the owner's call, landed by itself (BR-2074, BR-2295, D-51). */
export const REVIEW_WAYS_OUT = [
  `  set a reviewer in canon/config.yaml, a command that reads the review prompt on stdin and prints the verdict JSON on stdout: review: "${DEFAULT_REVIEW}"`,
  `  review: ${REVIEW_NONE} turns the review off: that is the owner's decision, not an agent's; ask with canon human ask, and with their yes land that canon/config.yaml change as a change of its own`,
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
    doc: `Reviewer for rule and decision text and for standing instructions, the built-in first \`before_land\` step (D-3). Receives the review prompt on stdin and prints JSON \`{"verdict":"ok"|"block","findings":["..."]}\`. Unset refuses a landing that changes them (BR-2074); \`${REVIEW_NONE}\` skips the reviews on purpose (D-51).`,
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
};
