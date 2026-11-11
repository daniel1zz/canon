import { err, ok } from "../../kernel/result.ts";
import { configKey, optionalString, positiveNumber, positiveValue } from "../../invocation/key.ts";

/** canon/config.yaml keys of the command that picks related documents from the fused ranking (BR-2443, D-90). */
export const queryKeys = {
  relatedPickCommand: configKey<string | undefined>({
    key: "related_pick_command",
    doc: "Optional command that picks the documents related to a rule or decision from the fused top 50 (BR-2443, D-90), run by `canon context <id>` and `canon work review` only, never by the edit hook, `canon check` or a landing. It reads a prompt on stdin (the document's text and each candidate's id, title and excerpt) and prints a JSON list on stdout, most likely first: `[{\"id\":\"<candidate id>\",\"reason\":\"<one line>\"}]` (a plain id string is an item without a reason). Read from canon/config.yaml on main; an answer is cached in the coordination database (BR-2444); a failure is said in one line and the fused ranking is listed (BR-2445). Unset: the fused ranking alone.",
    default: undefined,
    schema: optionalString,
    // reason: whitespace only is no command; null, empty and blank all mean unset, as for `review` (BR-2443)
    read: (v) => (v === null || (typeof v === "string" && v.trim() === "") ? ok(undefined) : typeof v === "string" ? ok(v) : err("invalid", "`related_pick_command` must be a string")),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 218,
    checked: 218,
  }),
  relatedPickTimeoutMs: configKey<number>({
    key: "related_pick_timeout_seconds",
    doc: "How long one run of `related_pick_command` may take before canon stops it and its children and lists the fused ranking (BR-2445).",
    default: 120_000,
    schema: positiveNumber(120),
    read: positiveValue("related_pick_timeout_seconds", 1000),
    listed: 219,
    checked: 219,
  }),
};
