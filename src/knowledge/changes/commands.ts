import { defineCommand } from "citty";
import { git } from "../../kernel/git.ts";
import { corpusOf, fail, json, list, must, say, workspace } from "../../invocation/command.ts";
import type { Change, Corpus } from "../documents/model.ts";
import { setMeta } from "../documents/write.ts";
import { findDoc } from "../query/query.ts";
import { changeIdsOnBranches, listedChanges } from "../../work/session/inflight.ts";
import { mainCorpus } from "../../work/session/session.ts";
import type { Workspace } from "../../work/workspace.ts";
import { cycleThrough } from "./deps.ts";
import { changeGraph, graphInputs, graphJson, graphLines, memberOf } from "./graph.ts";
import { dependsArg, isCriterionRef, issueArg, linkMeta, type ChangeLinks, type Prefixes } from "./links.ts";
import { criteriaByDoc } from "../releases/features.ts";

/** The command-line arguments that write a change's links (BR-2562, BR-2563). */
export const LINK_ARGS = {
  release: { type: "string", description: "The release this change belongs to (R-n); not with --feature (BR-2562)" },
  feature: { type: "string", description: "The feature this change belongs to (F-n); its release is the one listing it; not with --release (BR-2562)" },
  issue: { type: "string", description: "GitHub issue numbers this change fixes, comma separated (BR-2562)" },
  depends: { type: "string", description: "Changes this change depends on, comma separated (C-a,C-b); it is not offered to start before they land (BR-2564)" },
} as const;

export function prefixes(ws: Workspace): Prefixes {
  const of = (name: string) => ws.config.types.find((t) => t.name === name)!.prefix; // reason: change, release and feature are built in, never removed
  return { change: of("change"), release: of("release"), feature: of("feature") };
}

const given = (v: unknown): v is string => typeof v === "string";

/**
 * The links `args` name for a new change, checked before anything is allocated or written (BR-2562): the usage first
 * (exit 2), then the release or feature in `docs` and the dependencies anywhere a change can be (exit 3).
 */
export function newLinks(ws: Workspace, args: Record<string, unknown>, docs: Corpus): ChangeLinks {
  if (given(args["release"]) && given(args["feature"])) fail({ code: "invalid", message: "--release and --feature: give one; a feature's release is the one listing it (BR-2562)" });
  const out = newLinksUsage({ release: args["release"], feature: args["feature"], issue: args["issue"], depends: args["depends"] }, prefixes(ws));
  targetsExist(ws, out, docs);
  return out;
}

function issues(raw: string): number[] {
  const v = issueArg(list(raw));
  if (typeof v === "string" || v.length === 0) fail({ code: "invalid", message: `--issue takes GitHub issue numbers, comma separated (got ${JSON.stringify(typeof v === "string" ? v : raw)})` });
  return v;
}

function depends(raw: string, p: Prefixes): string[] {
  const v = dependsArg(list(raw), p);
  if (typeof v === "string" || v.length === 0) fail({ code: "invalid", message: `--depends takes change ids or success criteria (R-n/S<k>, F-n/S<k>), comma separated (got ${JSON.stringify(typeof v === "string" ? v : raw)})` });
  return v;
}

/** Every change id a dependency may name: this checkout's, main's and those on change branches (BR-2562, D-149). */
function knownChanges(ws: Workspace): Set<string> {
  const ids = new Set<string>();
  for (const c of [...corpusOf(ws).corpus.docs, ...must(mainCorpus(ws)).docs]) if (c.kind === "change") ids.add(c.id);
  for (const id of must(changeIdsOnBranches(ws))) ids.add(id);
  return ids;
}

function targetsExist(ws: Workspace, l: ChangeLinks, docs: Corpus): void {
  if (l.release !== undefined && findDoc(docs, l.release)?.kind !== "release") fail({ code: "not_found", message: `${l.release} is not a release here` });
  if (l.feature !== undefined && findDoc(docs, l.feature)?.kind !== "feature") fail({ code: "not_found", message: `${l.feature} is not a feature here` });
  // reason: a success criterion is read from the release or feature here, like --release; a change may be anywhere (BR-2562, D-149)
  const criteria = criteriaByDoc(docs);
  const unknown = (l.dependsOn ?? []).filter(isCriterionRef).filter((ref) => { const [doc, sid] = ref.split("/") as [string, string]; return !criteria.get(doc)?.some((c) => c.id === sid); });
  if (unknown.length > 0) fail({ code: "not_found", message: `${unknown.join(", ")}: no such success criterion in a release or feature here` });
  const named = [...(l.dependsOn ?? []).filter((d) => !isCriterionRef(d)), ...(l.doneBy !== undefined ? [l.doneBy] : [])];
  if (named.length === 0) return;
  const known = knownChanges(ws);
  const missing = named.filter((id) => !known.has(id));
  if (missing.length > 0) fail({ code: "not_found", message: `${missing.join(", ")}: not a change in this checkout, on main or on any change branch` });
}

/** `canon change link`: edit the links of a change in this checkout, to commit with the change (BR-2563). */
export const linkCmd = defineCommand({
  meta: { description: "Edit a change's links in this checkout (its worktree): --release or --feature, --issue, --depends on an open change, --done-by on a dropped one; `none` removes one. Commit it with your change" },
  args: {
    change: { type: "positional", required: true, description: "The change (C-1)" },
    ...LINK_ARGS,
    "done-by": { type: "string", description: "On a dropped change: the change that did its work instead (BR-2563)" },
  },
  run({ args }) {
    const ws = workspace();
    const p = prefixes(ws);
    const id = String(args.change).trim().toUpperCase();
    const a = args as Record<string, unknown>;
    const keys = ["release", "feature", "issue", "depends", "done-by"].filter((k) => given(a[k]));
    if (keys.length === 0) fail({ code: "invalid", message: "give at least one of --release, --feature, --issue, --depends, --done-by (BR-2563)" });
    if (given(a["release"]) && given(a["feature"])) fail({ code: "invalid", message: "--release and --feature: give one; a feature's release is the one listing it (BR-2563)" });
    const none = (k: string) => given(a[k]) && (a[k] as string).trim().toLowerCase() === "none";
    // reason: only the values given are checked and written; `none` removes the key (BR-2563)
    const set = Object.fromEntries(keys.filter((k) => !none(k)).map((k) => [k, a[k]]));
    const links = newLinksUsage(set, p);
    if (links.doneBy === id) fail({ code: "invalid", message: `--done-by ${id}: a change is not done by itself; name the change that did its work` });
    const { corpus } = corpusOf(ws);
    const doc = findDoc(corpus, id);
    if (!doc || doc.kind !== "change") fail({ code: "not_found", message: `${id} is not a change in this checkout; run canon change link in a worktree that has its file` });
    const wants = keys.includes("done-by") ? "dropped" : "open";
    if (keys.includes("done-by") && keys.length > 1) fail({ code: "invalid", message: "--done-by goes alone: it is for a dropped change, the other links for an open one (BR-2563)" });
    if (doc.status !== wants) fail({ code: "invalid", message: `${id} is ${doc.status}; ${wants === "dropped" ? "--done-by is only for a dropped change" : "only an open change's links are edited"} (BR-2563)` });
    targetsExist(ws, links, corpus);
    const next = merged(doc, keys, links);
    if (next.dependsOn !== undefined) {
      const cycle = cycleThrough(id, graph(ws, corpus, id, next.dependsOn));
      if (cycle) fail({ code: "refused", message: `${id} would depend on itself through ${cycle.join(" → ")}; nothing written (BR-2565)` });
    }
    must(setMeta(ws.root, doc, linkMeta(next), doc.status));
    ws.db.event(ws.actor, "change.link", id, linkMeta(next));
    say(`${id} → ${describe(next)} (${doc.path}; commit it with your change)`);
  },
});

/** The usage checks of BR-2562 on the given values, without looking anything up. */
function newLinksUsage(set: Record<string, unknown>, p: Prefixes): ChangeLinks {
  const out: { -readonly [K in keyof ChangeLinks]: ChangeLinks[K] } = {};
  const id = (k: string, prefix: string, what: string): string | undefined => {
    if (!given(set[k])) return undefined;
    const v = set[k].trim().toUpperCase();
    if (!new RegExp(`^${prefix}-\\d+$`).test(v)) fail({ code: "invalid", message: `--${k} ${v}: give a ${what} id such as ${prefix}-1` });
    return v;
  };
  const release = id("release", p.release, "release");
  const feature = id("feature", p.feature, "feature");
  const doneBy = id("done-by", p.change, "change");
  if (release !== undefined) out.release = release;
  if (feature !== undefined) out.feature = feature;
  if (doneBy !== undefined) out.doneBy = doneBy;
  if (given(set["issue"])) out.issues = issues(set["issue"]);
  if (given(set["depends"])) out.dependsOn = depends(set["depends"], p);
  return out;
}

/** The change's links after the edit: given keys replaced (or removed by `none`), release and feature one at most (BR-2563). */
function merged(doc: Change, keys: readonly string[], l: ChangeLinks): ChangeLinks {
  const has = (k: string) => keys.includes(k);
  const release = has("release") ? l.release : has("feature") ? undefined : doc.release;
  const feature = has("feature") ? l.feature : has("release") ? undefined : doc.feature;
  const issues = has("issue") ? l.issues : doc.issues;
  const dependsOn = has("depends") ? l.dependsOn : doc.dependsOn;
  const doneBy = has("done-by") ? l.doneBy : doc.doneBy;
  return { ...(release ? { release } : {}), ...(feature ? { feature } : {}), ...(issues ? { issues } : {}), ...(dependsOn ? { dependsOn } : {}), ...(doneBy ? { doneBy } : {}) };
}

/** The dependency graph the edit would make: main's changes, those on branches, this checkout's, then the edited one (BR-2563). */
function graph(ws: Workspace, corpus: Corpus, id: string, deps: readonly string[]): Map<string, readonly string[]> {
  const main = must(mainCorpus(ws));
  const edges = new Map<string, readonly string[]>();
  for (const l of must(listedChanges(ws, main, [], () => true)).listed) edges.set(l.change.id, l.change.dependsOn ?? []);
  for (const d of corpus.docs) if (d.kind === "change") edges.set(d.id, d.dependsOn ?? []);
  edges.set(id, deps);
  return edges;
}

function describe(l: ChangeLinks): string {
  const parts = [
    l.release ? `release ${l.release}` : l.feature ? `feature ${l.feature}` : "no release or feature",
    l.issues?.length ? `issues ${l.issues.join(", ")}` : undefined,
    l.dependsOn?.length ? `depends on ${l.dependsOn.join(", ")}` : undefined,
    l.doneBy ? `done by ${l.doneBy}` : undefined,
  ];
  return parts.filter(Boolean).join("; ");
}

/** `canon change graph <R-n|F-n>`: the dependency graph of a release's or feature's changes, worked out now (BR-2570). */
export const graphCmd = defineCommand({
  meta: { description: "The dependency graph of a release's or feature's changes (landed, in progress, waiting for whom, ready), from depends_on; --json for scripts" },
  args: { id: { type: "positional", required: true, description: "A release (R-n) or feature (F-n)" }, json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const { corpus } = corpusOf(ws);
    const id = String(args.id).trim().toUpperCase();
    const doc = findDoc(corpus, id);
    // reason: an id that is no release or feature is not found, and nothing goes to stdout (BR-2570, BR-2022)
    if (!doc || (doc.kind !== "release" && doc.kind !== "feature")) fail({ code: "not_found", message: `${id} is not a release or feature` });
    const nodes = changeGraph(must(graphInputs(ws)), memberOf(corpus, doc));
    if (args.json) return json(graphJson(doc, nodes));
    for (const line of graphLines(doc, nodes)) say(line);
  },
});

/**
 * `canon change close`: a change whose work some other commit already carried into main (a landing by hand) is closed
 * with that commit written down, in this checkout, to commit with the caller's change (BR-2573, D-151).
 */
export const closeCmd = defineCommand({
  meta: { description: "Close a change whose work is already on main (landed by another commit): writes status done and landed_in <commit> in this checkout; commit it with your change" },
  args: {
    change: { type: "positional", required: true, description: "The change (C-n)" },
    commit: { type: "string", description: "The commit on main that carried its work (BR-2573)" },
  },
  run({ args }) {
    const ws = workspace();
    const id = String(args.change).trim().toUpperCase();
    const { corpus } = corpusOf(ws);
    const doc = findDoc(corpus, id);
    if (!doc || doc.kind !== "change") fail({ code: "not_found", message: `${id} is not a change in this checkout; nothing written (BR-2573)` });
    if (doc.status !== "open") fail({ code: "invalid", message: `${id} is ${doc.status}, not open; only an open change is closed (BR-2573)` });
    if (typeof args.commit !== "string" || args.commit.trim() === "") fail({ code: "invalid", message: "--commit <commit> is required: the commit on main that carried the work (BR-2573)" });
    const sha = git(ws.primary, "rev-parse", "--verify", "-q", `${args.commit.trim()}^{commit}`);
    if (!sha.ok) fail({ code: "not_found", message: `--commit ${args.commit}: no such commit; nothing written (BR-2573)` });
    // reason: only a commit main contains carried the work to main; one on a branch has not landed (BR-2573, D-149)
    if (!git(ws.primary, "merge-base", "--is-ancestor", sha.value, ws.config.main).ok) fail({ code: "not_found", message: `--commit ${args.commit}: ${sha.value.slice(0, 9)} is not on ${ws.config.main}; nothing written (BR-2573)` });
    must(setMeta(ws.root, doc, { status: "done", landed_in: sha.value }, doc.status));
    ws.db.event(ws.actor, "change.close", id, { commit: sha.value });
    say(`${id} → done, landed in ${sha.value.slice(0, 9)} (${doc.path}; commit it with your change)`);
  },
});
