import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, REL_DIR, relPath, stringValue } from "../../config/key.ts";

/** The `review` value that turns the rule and duplicate reviews off on purpose; unset refuses instead (BR-2074, D-51). */
export const REVIEW_NONE = "none";

/** The command an unset `review` should become, as `canon init` writes it (BR-2032) and the refusal suggests (BR-2074). */
export const DEFAULT_REVIEW = "claude -p --output-format text";

/** canon/config.yaml keys of the rule review and the duplicate review (C-135). */
export const reviewKeys = {
  review: configKey<string | undefined>({
    key: "review",
    doc: `Reviewer for rule and decision text and for standing instructions, the built-in first \`before_land\` step (D-3). Receives the review prompt on stdin and prints JSON \`{"verdict":"ok"|"block","findings":["..."]}\`. Unset refuses a landing that changes them (BR-2074); \`${REVIEW_NONE}\` skips the reviews on purpose (D-51).`,
    default: undefined,
    schema: optionalString,
    read: stringValue("review"),
    // reason: `none` is the opt-out, not a program to look up (BR-2074)
    commands: (v) => (v === undefined || v === REVIEW_NONE ? [] : [v]),
    listed: 60,
    checked: 40,
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
