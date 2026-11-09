import { parseDocFile } from "../documents/docfile.ts";
import type { Change, Corpus, Release, Rule } from "../documents/model.ts";
import { readPlan } from "../plans/parse.ts";
import { section } from "../documents/templates.ts";
import { git } from "../../kernel/git.ts";
import type { Finding } from "../check/check.ts";

/** The sections of a shipped release that never change (D-61): what it aims at, what it delivers, what it leaves out. */
export const FROZEN_SECTIONS: readonly string[] = ["目标", "范围", "不做"];

const squeeze = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** Every id a rule's `release` and `changed_in` name, with the key it was written under. */
const tagsOf = (rule: Rule): { key: "release" | "changed_in"; id: string }[] => [
  ...(rule.release !== undefined ? [{ key: "release" as const, id: rule.release }] : []),
  ...(rule.changedIn ?? []).map((id) => ({ key: "changed_in" as const, id })),
];

/**
 * The release checks of `canon check` (D-61): tags name existing releases, and a shipped release stays what it was at
 * `shipped_at`: its 目标, 范围 and 不做 and the set of rules tagged with it. The shipped commit is the baseline, so no copy is kept.
 */
export function releaseFindings(root: string, corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const rules = corpus.docs.filter((d): d is Rule => d.kind === "rule");
  for (const rule of rules) {
    for (const { key, id } of tagsOf(rule)) {
      // reason: the prefix R belongs to releases alone (no declared type may reuse it), so an id that exists is a release (D-61)
      if (!corpus.docs.some((d) => d.id === id)) out.push({ path: rule.path, rule: "ref-dangling", message: `${rule.id} \`${key}\` names ${id}, which does not exist` });
    }
  }
  const plans = corpus.docs.filter((d): d is Change => d.kind === "change" && d.release !== undefined);
  for (const change of plans) {
    if (!corpus.docs.some((d) => d.id === change.release)) out.push({ path: change.path, rule: "ref-dangling", message: `${change.id} \`release\` names ${change.release!}, which does not exist` });
    // reason: `release` on a change says which release its plan belongs to; without a plan it says nothing (D-79)
    if (readPlan(change.body).kind !== "plan") out.push({ path: change.path, rule: "file-invalid", message: `${change.id} has \`release: ${change.release!}\` but no valid ## 计划: \`release\` on a change names the release its plan belongs to (D-79)` });
  }
  for (const release of corpus.docs.filter((d): d is Release => d.kind === "release" && d.status === "shipped")) out.push(...frozenFindings(root, release, rules), ...frozenPlans(root, release, plans, corpus));
  return out;
}

/** A shipped release's set of plans does not change either: the plan changes tagged with it at `shipped_at` (D-79, like BR-2326 for rules). */
function frozenPlans(root: string, release: Release, tagged: readonly Change[], corpus: Corpus): Finding[] {
  const at = release.shippedAt!;
  const then = taggedAt(root, at, release.id, "canon/changes");
  if (typeof then === "string") return [{ path: release.path, rule: "release-frozen", message: then }];
  const out: Finding[] = [];
  for (const id of then) {
    const now = corpus.docs.find((d): d is Change => d.kind === "change" && d.id === id);
    if (now && now.release !== release.id) out.push({ path: now.path, rule: "release-frozen", message: `${id}'s plan was tagged ${release.id} when it shipped (${at.slice(0, 9)}); its \`release\` is ${now.release ?? "gone"} now, and the plans of a shipped release do not change (D-79)` });
  }
  for (const change of tagged) {
    if (change.release === release.id && !then.has(change.id)) out.push({ path: change.path, rule: "release-frozen", message: `${change.id}'s plan is tagged ${release.id}, but it was not when ${release.id} shipped (${at.slice(0, 9)}); a plan added to a shipped release changes what shipped: tag it with a later release (D-79)` });
  }
  return out;
}

function frozenFindings(root: string, release: Release, rules: readonly Rule[]): Finding[] {
  const at = release.shippedAt!;
  const frozen = (message: string, path = release.path): Finding => ({ path, rule: "release-frozen", message });
  const then = git(root, "show", `${at}:${release.path}`);
  if (!then.ok) return [frozen(`${release.id} says it shipped at ${at}, but that commit has no ${release.path} (${then.error.message.split("\n")[0]}); a shipped release is compared with that commit, so it must be there`)];
  const old = parseDocFile(then.value, release.path);
  if (!old.ok) return [frozen(`${release.id} at ${at.slice(0, 9)} does not parse: ${old.error.message}`)];
  const out: Finding[] = [];
  for (const name of FROZEN_SECTIONS) {
    if (squeeze(section(old.value.body, `## ${name}`)) !== squeeze(section(release.body, `## ${name}`))) {
      out.push(frozen(`${release.id} shipped at ${at.slice(0, 9)}: its ## ${name} changed since; a shipped release's ${FROZEN_SECTIONS.map((s) => `## ${s}`).join(", ")} do not change (D-61)`));
    }
  }
  const tagged = taggedAt(root, at, release.id, "canon/rules");
  if (typeof tagged === "string") return [...out, frozen(tagged)];
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const id of tagged) {
    const now = byId.get(id);
    if (now && now.release !== release.id) out.push(frozen(`${id} was tagged ${release.id} when it shipped (${at.slice(0, 9)}); its \`release\` is ${now.release ?? "gone"} now, and the release of a shipped release's rule does not change (D-61)`, now.path));
  }
  for (const rule of rules) {
    if (rule.release === release.id && !tagged.has(rule.id)) out.push(frozen(`${rule.id} is tagged ${release.id}, but it was not when ${release.id} shipped (${at.slice(0, 9)}); a rule added to a shipped release changes what shipped: tag it with a later release, and write \`changed_in\` for a rule that release changes (D-61)`, rule.path));
  }
  return out;
}

/** The ids of the documents under `dir` tagged `release` in the tree of commit `at`, or why that cannot be read. */
function taggedAt(root: string, at: string, release: string, dir: string): Set<string> | string {
  const pattern = `^release:[[:space:]]*["']?${release}["']?[[:space:]]*$`;
  // reason: git grep exits 1 for "no match", which git() reports as a failure; only exit 0 and 1 are answers (D-61)
  const r = Bun.spawnSync(["git", "grep", "-l", "-E", pattern, at, "--", dir], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0 && r.exitCode !== 1) return `${release} shipped at ${at}, but git cannot read that commit's ${dir}: ${r.stderr.toString().trim().split("\n")[0]}`;
  const ids = new Set<string>();
  for (const line of r.stdout.toString().split("\n").filter(Boolean)) {
    const file = line.slice(at.length + 1);
    const id = file.split("/").pop()!.match(/^[A-Z][A-Z0-9]*-\d+(?=\.md$)/)?.[0];
    if (id === undefined) continue;
    const text = git(root, "show", `${at}:${file}`);
    const meta = text.ok ? parseDocFile(text.value, file) : undefined;
    if (meta?.ok && meta.value.meta["release"] === release) ids.add(id);
  }
  return ids;
}
