import { createHash } from "node:crypto";
import type { PassMethod, PassRecord } from "./model.ts";
import { EXAMPLE_SECTION, RULE_SECTION, section } from "./templates.ts";

/** Every run of whitespace as one space, trimmed: blank lines and indentation do not change behaviour (BR-2236). */
const normalise = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** The two sections a rule's behaviour hash is made of, normalised (BR-2236). */
export function behaviourParts(body: string): { statement: string; examples: string } {
  return { statement: normalise(section(body, RULE_SECTION)), examples: normalise(section(body, EXAMPLE_SECTION)) };
}

/**
 * BR-2236: the first 16 hex characters of the SHA-256 of `规则\n<statement>\n例子\n<examples>`. Only these two
 * sections count, so a title, status, background or README edit leaves a rule's execution state as it was (D-32).
 */
export function behaviourHash(body: string): string {
  const { statement, examples } = behaviourParts(body);
  return createHash("sha256").update(`规则\n${statement}\n例子\n${examples}`).digest("hex").slice(0, 16);
}

const METHODS: readonly PassMethod[] = ["test", "test-file", "acceptance", "migration"];
const VALUE = /^([0-9a-f]{16}) (test|test-file|acceptance|migration)( wording)?$/;
const RULE_ID = /^[A-Z][A-Z0-9]*-\d+$/;

/** The one-line value a pass record is written as: `<hash> <method>[ wording]` (BR-2237). */
export const formatPass = (r: PassRecord): string => `${r.hash} ${r.method}${r.wording ? " wording" : ""}`;

/** A change's `passes` front matter (BR-2237), or the problem with it. */
export function parsePasses(v: unknown): Record<string, PassRecord> | string {
  if (v === undefined) return {};
  const bad = `\`passes\` must map rule ids to "<16 hex hash> <${METHODS.join("|")}>[ wording]" (BR-2237)`;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad;
  const out: Record<string, PassRecord> = {};
  for (const [id, value] of Object.entries(v as Record<string, unknown>)) {
    const m = typeof value === "string" ? VALUE.exec(value) : null;
    if (!RULE_ID.test(id) || !m) return bad;
    out[id] = { hash: m[1]!, method: m[2] as PassMethod, wording: m[3] !== undefined };
  }
  return out;
}

const LINK_VALUE = /^[0-9a-f]{16}$/;

/** A rule's or decision's `links` front matter (BR-2425): document id → 16 hex fingerprint, or the problem with it. */
export function parseLinks(v: unknown): Record<string, string> | string {
  if (v === undefined) return {};
  const bad = "`links` must map document ids to the 16 hex fingerprint `canon links confirm` wrote (BR-2425)";
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad;
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(v as Record<string, unknown>)) {
    if (!RULE_ID.test(id) || typeof value !== "string" || !LINK_VALUE.test(value)) return bad;
    out[id] = value;
  }
  return out;
}
