import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../../work/db.ts";
import type { Corpus, Release } from "../documents/model.ts";
import { parseDocFile } from "../documents/docfile.ts";
import { executionStates } from "../../work/execution/state.ts";
import type { FloorTiming } from "../../work/watch/config-keys.ts";
import { ownerConfirmation, shipBlockers } from "./gate.ts";

/**
 * The landing's release check (BR-2332, BR-2335, D-61): a release becomes `shipped` only through `canon release ship`, which
 * records a `release.ship` event for the change it lands; and a shipped release never stops being shipped. Hand-written
 * `status: shipped` therefore cannot reach main, whoever writes it. A release that does become shipped must also still
 * meet its conditions now, in the tree that lands: every rule tagged with it passed, and the owner's yes standing.
 */
export function landingReleases(i: { readonly primary: string; readonly timing: FloorTiming; readonly db: CoordDb; readonly wt: string; readonly base: string; readonly head: string; readonly corpus: Corpus; readonly subject: string | null }): { ok: true } | { ok: false; message: string } {
  const diff = git(i.wt, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", i.base, i.head, "--", "canon/releases");
  const entries = (diff.ok && diff.value !== "" ? diff.value.split("\n") : []).map((l) => {
    const [status, path] = l.split("\t") as [string, string];
    return { status: status[0]!, path };
  });
  const problems: string[] = [];
  for (const e of entries) {
    const before = e.status === "A" ? undefined : statusAt(i.wt, i.base, e.path);
    if (before?.status === "shipped") {
      const now = e.status === "D" ? undefined : i.corpus.docs.find((d): d is Release => d.kind === "release" && d.path === e.path);
      if (now?.status !== "shipped" || now.shippedAt !== before.shippedAt) problems.push(`${before.id} is shipped on main; a shipped release stays as it shipped (its status and shipped_at do not change, and it is not deleted)`);
      continue;
    }
    const now = e.status === "D" ? undefined : i.corpus.docs.find((d): d is Release => d.kind === "release" && d.path === e.path);
    if (now?.status !== "shipped") continue;
    const recorded = i.subject === null ? [] : i.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'release.ship' AND subject = ?").all(i.subject);
    if (!recorded.some((r) => (JSON.parse(r.detail) as { release?: string; shipped_at?: string }).release === now.id && (JSON.parse(r.detail) as { shipped_at?: string }).shipped_at === now.shippedAt)) {
      problems.push(`${now.id} becomes shipped, but ${i.subject ?? "this landing"} has no release.ship record for it at ${now.shippedAt}: only \`canon release ship ${now.id}\` ships a release, after the owner's recorded yes`);
      continue;
    }
    // reason: ship checked these when it started; the landing may wait behind others, so they are checked again on the tree that lands (BR-2335)
    const blockers = shipBlockers(i.corpus, executionStates(i.primary, i.corpus, i.timing), now.id);
    if (blockers.length > 0) problems.push(`${now.id} no longer meets its conditions to ship (every rule tagged with it must be passed and every plan tagged with it done):\n${blockers.map((b) => `  - ${b}`).join("\n")}\nrun \`canon release ship ${now.id}\` again once they are`);
    const confirmed = ownerConfirmation(i.db, now.id);
    if (!confirmed.ok) problems.push(`${now.id}: the owner's confirmation no longer stands: ${confirmed.message}`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join("\n") };
}

function statusAt(wt: string, ref: string, path: string): { id: string; status: unknown; shippedAt: unknown } | undefined {
  const text = git(wt, "show", `${ref}:${path}`);
  const parsed = text.ok ? parseDocFile(text.value, path) : undefined;
  return parsed?.ok ? { id: String(parsed.value.meta["id"]), status: parsed.value.meta["status"], shippedAt: parsed.value.meta["shipped_at"] } : undefined;
}
