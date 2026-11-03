import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey } from "../../config/key.ts";
import { CHECKS } from "./checks.ts";

/** canon/config.yaml keys of `canon stats` (C-135). */
export const statsKeys = {
  checkReviews: configKey<Readonly<Record<string, string>>>({
    key: "check_reviews",
    doc: "Check name → the date (YYYY-MM-DD) it is due for review (BR-2069).",
    default: {},
    schema: { type: ["object", "null"], propertyNames: { enum: CHECKS }, additionalProperties: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, default: {} },
    read: readCheckReviews,
    listed: 130,
    checked: 190,
  }),
};

function readCheckReviews(v: unknown): Result<Record<string, string>> {
  if (v === null) return ok({});
  if (typeof v !== "object" || Array.isArray(v)) return err("invalid", "`check_reviews` must be a mapping of check name → date (YYYY-MM-DD)");
  const out: Record<string, string> = {};
  for (const [name, date] of Object.entries(v as Record<string, unknown>)) {
    if (!CHECKS.includes(name)) return err("invalid", `\`check_reviews.${name}\`: no such check (checks: ${CHECKS.join(", ")})`);
    const text = date instanceof Date ? date.toISOString().slice(0, 10) : date;
    // Date.parse accepts 2026-02-30 (it rolls over to March), so the date must survive a round trip.
    const real = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (!real) return err("invalid", `\`check_reviews.${name}\` must be a real date like 2027-02-01`);
    out[name] = text;
  }
  return ok(out);
}
