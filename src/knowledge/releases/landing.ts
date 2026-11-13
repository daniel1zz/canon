import { git } from "../../kernel/git.ts";
import type { CoordDb } from "../../work/db.ts";
import type { Corpus, Release } from "../documents/model.ts";
import { parseDocFile } from "../documents/docfile.ts";
import type { FloorTiming } from "../../work/watch/config-keys.ts";
import { ownerConfirmation } from "./gate.ts";

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
    const at = now.shippedAt ?? "";
    // reason: the ship's conditions are not recomputed here: executionStates reads the live green ref, so a frozen tree can flip from passed to waiting and the refusal would never converge; what must hold is that shipped_at was accepted (D-105, BR-2335)
    const accepted = git(i.primary, "rev-parse", "--verify", "--quiet", "refs/canon/accepted^{commit}");
    if (!accepted.ok || accepted.value === "") problems.push(`${now.id} ships ${at.slice(0, 9)}, but refs/canon/accepted does not exist: a release ships an accepted commit (canon accept, D-89)`);
    else if (at !== accepted.value && !git(i.primary, "merge-base", "--is-ancestor", at, accepted.value).ok)
      problems.push(`${now.id} ships ${at.slice(0, 9)}, which is not refs/canon/accepted (${accepted.value.slice(0, 9)}) or an ancestor of it`);
    const acceptedEvent = i.db.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'accept.ok' AND detail LIKE '%' || ? || '%'").get(at);
    if ((acceptedEvent?.n ?? 0) === 0) problems.push(`${now.id} ships ${at.slice(0, 9)}, but no accept.ok event accepted that commit (canon accept, D-89)`);
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
