/**
 * The current time in milliseconds. `CANON_NOW` (an ISO date) replaces the clock, so that a test can put "now" 19 or
 * 21 minutes after a commit without sleeping (BR-2311). A value that is not a date fails loudly.
 */
export function nowMs(): number {
  const v = process.env["CANON_NOW"];
  if (v === undefined || v === "") return Date.now();
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`CANON_NOW=${JSON.stringify(v)} is not a date (use an ISO date such as 2026-11-04T10:00:00Z)`);
  return t;
}
