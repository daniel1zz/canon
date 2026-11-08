import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { git } from "../../../kernel/git.ts";
import type { CoordDb } from "../../db.ts";
import type { Corpus } from "../../../knowledge/documents/model.ts";
import { parseDocFile } from "../../../knowledge/documents/docfile.ts";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * BR-2362: a rule or decision id the landing adds must not be one the coordination record allocated to another change's
 * worktree. Allocated in this change's worktree, in the primary checkout, or not recorded at all, it passes.
 */
export function landingAllocations(i: { readonly db: CoordDb; readonly primary: string; readonly wt: string; readonly worktree: string; readonly base: string; readonly head: string; readonly corpus: Corpus }): { ok: true } | { ok: false; reason: "check" | "environment"; message: string } {
  const diff = git(i.wt, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", i.base, i.head, "--", "canon/rules", "canon/decisions");
  if (!diff.ok) return { ok: false, reason: "environment", message: diff.error.message };
  const entries = (diff.value === "" ? [] : diff.value.split("\n")).map((l) => {
    const [status, path] = l.split("\t") as [string, string];
    return { status: status[0]!, path };
  });
  // reason: a file moved with the same id is a delete plus an add; its id is not new to main (BR-2362)
  const gone = new Set<string>();
  for (const e of entries.filter((x) => x.status === "D")) {
    const text = git(i.wt, "show", `${i.base}:${e.path}`);
    const parsed = text.ok ? parseDocFile(text.value, e.path) : undefined;
    if (parsed?.ok) gone.add(String(parsed.value.meta["id"]));
  }
  const added = new Set(entries.filter((x) => x.status === "A").map((x) => x.path));
  const mine = real(i.worktree);
  const home = real(i.primary);
  const problems: string[] = [];
  for (const d of i.corpus.docs) {
    if ((d.kind !== "rule" && d.kind !== "decision") || !added.has(d.path) || gone.has(d.id)) continue;
    const held = i.db.db.query<{ worktree: string | null }, [string]>("SELECT worktree FROM events WHERE kind = 'id.allocate' AND subject = ?").all(d.id).flatMap((r) => (r.worktree ? [real(r.worktree)] : []));
    if (held.length === 0 || held.some((w) => w === mine || w === home)) continue;
    const holder = held[0]!;
    const change = /^C-\d+$/.test(basename(holder)) ? ` (${basename(holder)})` : "";
    problems.push(`${d.id} (${d.path}) was allocated in ${holder}${change}, not in this change's worktree: renumber it with \`canon ${d.kind} new\`${d.kind === "rule" ? " --domain <domain>" : ""} (BR-2362)`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, reason: "check", message: `ids allocated to another change:\n${problems.map((p) => `  - ${p}`).join("\n")}` };
}
