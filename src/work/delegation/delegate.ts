import { createHash } from "node:crypto";
import { parse } from "yaml";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { proseIds } from "../../knowledge/links/links.ts";
import { section, RULE_SECTION } from "../../knowledge/documents/templates.ts";
import type { Change, Corpus, Doc } from "../../knowledge/documents/model.ts";
import { corpusOf } from "../session/session.ts";
import { branchSubject } from "../session/subject.ts";
import type { Say, Workspace } from "../workspace.ts";
import { isWorker } from "./worker.ts";
import { delegationKeys } from "./config-keys.ts";
import { measure, refusal, refusalMessage, unmeasured, unmeasuredLines } from "./capacity.ts";
import { delegation, delegationNotice, type ContractItem, type Delegation } from "./records.ts";
import { startNotices } from "./notices.ts";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import { isDeepStrictEqual } from "node:util";

export const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** Read exact blob bytes, including the final newline (BR-2497's full content hash). */
export function blob(ws: Workspace, revision: string, path: string): Buffer | undefined {
  const r = Bun.spawnSync(["git", "show", `${revision}:${path}`], { cwd: ws.primary, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout : undefined;
}

/** Only the planned→active metadata transition is exempt; even another frontmatter field is a design edit. */
export function activationOnly(before: string | undefined, after: string | undefined): boolean {
  if (!before || !after) return false;
  const a = parseDocFile(before, "contract"), b = parseDocFile(after, "contract");
  if (!a.ok || !b.ok || a.value.body !== b.value.body) return false;
  const old = a.value.meta, next = b.value.meta;
  if (old.status !== "planned" || next.status !== "active" || "will_amend" in next) return false;
  delete old.status; delete next.status; delete old.will_amend;
  return isDeepStrictEqual(old, next);
}

/** The hash of a change file's 为什么 and 要改什么 sections: the task a delegation fixes (BR-2497) and a worker landing compares (BR-2501). */
export const taskHashOf = (body: string): string => hash(JSON.stringify([section(body, "## 为什么") ?? "", section(body, "## 要改什么") ?? ""]));

/** `canon/config.yaml` as it is at `revision`; empty when it has none. */
export function configAt(ws: Workspace, revision: string): Record<string, unknown> {
  const text = blob(ws, revision, "canon/config.yaml");
  return text === undefined ? {} : ((parse(text.toString()) ?? {}) as Record<string, unknown>);
}

/** The `design_paths` of a config read from main (BR-2497, BR-2501). */
export const designPathsOf = (ws: Workspace, config: Record<string, unknown>): Result<readonly string[]> => delegationKeys.designPaths.read(config.design_paths ?? [], { root: ws.primary, raw: config });

function changeAt(ws: Workspace, revision: string, subject: string): Result<{ corpus: Corpus; change: Change }> {
  const corpus = corpusOf(ws, revision);
  if (!corpus.ok) return corpus;
  const change = corpus.value.docs.find((d): d is Change => d.id === subject && d.kind === "change");
  return change ? ok({ corpus: corpus.value, change }) : err("not_found", `${subject} does not exist`);
}

/**
 * The contract items a delegation of `change` fixes (BR-2497): its rules, their `will_amend` targets, the rules and
 * decisions their 规则 section names (one level), canon/product.md and `extra` paths; by path, with the document id when
 * the item is a document. A rule or decision id no document has is `unpublished`. `docOf` looks a document up by id.
 * `canon work delegate` and the change states (BR-2571's ready-delegatable) both use it, so they judge alike.
 */
export function contractWanted(docOf: (id: string) => Doc | undefined, types: Corpus["types"], change: Change, extra: readonly string[]): { wanted: Map<string, string | undefined>; unpublished: Set<string> } {
  const wanted = new Map<string, string | undefined>();
  const unpublished = new Set<string>();
  const add = (name: string) => {
    const doc = docOf(name);
    if (doc) wanted.set(doc.path, doc.id);
    else if (/^(BR|D)-\d+$/.test(name)) unpublished.add(name);
    else wanted.set(name, undefined);
  };
  for (const id of change.rules) {
    add(id);
    const rule = docOf(id);
    if (rule?.kind !== "rule") continue;
    for (const target of rule.willAmend ?? []) add(target);
    for (const ref of proseIds(types, id, section(rule.body, RULE_SECTION) ?? "")) {
      if (/^(BR|D)-\d+$/.test(ref)) add(ref);
    }
  }
  add("canon/product.md");
  for (const path of extra) add(path);
  return { wanted, unpublished };
}

/**
 * `implicit`: the delegation a main session's own subagent `by` makes for its session when it starts an undelegated change
 * (BR-2610); `ws.actor` is then that session, the design owner. It is not refused for machine capacity: the subagent is
 * already running, and refusing its claim frees nothing.
 */
export function delegate(ws: Workspace, subject: string, worker: string, contracts: readonly string[], say: Say, implicit?: { readonly by: string }): Result<Delegation> {
  if (isWorker(ws.actor) || ws.actor === "agent:unknown") return err("invalid", "only a recognized primary session can delegate work");
  if (!/^[A-Za-z0-9_-]+$/.test(worker)) return err("invalid", "--to is letters, digits, - and _ only");
  const revision = git(ws.primary, "rev-parse", "--verify", `${ws.config.main}^{commit}`);
  if (!revision.ok) return revision;
  const branches = git(ws.primary, "for-each-ref", "--format=%(refname:short)", "refs/heads/change/");
  if (!branches.ok) return branches;
  const candidates = branches.value.split("\n").filter((b) => branchSubject(b) === subject);
  if (candidates.length > 1) return err("conflict", `${subject} has more than one branch`);
  const branch = candidates[0];
  const tip = branch ? git(ws.primary, "rev-parse", `${branch}^{commit}`) : revision;
  if (!tip.ok) return tip;
  const task = changeAt(ws, tip.value, subject);
  if (!task.ok) return task;
  const main = corpusOf(ws, revision.value);
  if (!main.ok) return main;
  const closed = main.value.docs.find((d) => d.id === subject && d.kind === "change" && d.status !== "open");
  if (closed || task.value.change.status !== "open") return err("not_found", `${subject} is closed`);
  const config = configAt(ws, revision.value);
  const paths = designPathsOf(ws, config);
  if (!paths.ok) return paths;
  const { wanted, unpublished } = contractWanted((id) => main.value.docs.find((d) => d.id === id) ?? task.value.corpus.docs.find((d) => d.id === id), main.value.types, task.value.change, [...paths.value, ...contracts]);
  const base = branch ? git(ws.primary, "merge-base", revision.value, tip.value) : revision;
  if (!base.ok) return base;
  const manifest: ContractItem[] = [];
  for (const [path, id] of wanted) {
    const text = blob(ws, revision.value, path);
    if (text === undefined) { unpublished.add(id ?? path); continue; }
    const before = blob(ws, base.value, path), after = blob(ws, tip.value, path);
    const same = before === undefined ? after === undefined : after !== undefined && before.equals(after);
    if (branch && !same && !(id?.startsWith("BR-") && activationOnly(before?.toString(), after?.toString()))) unpublished.add(path);
    manifest.push({ path, ...(id ? { id } : {}), hash: hash(text) });
  }
  if (unpublished.size) return err("refused", `publish these contract items to ${ws.config.main} first: ${[...unpublished].join(", ")}`);
  const taskHash = taskHashOf(task.value.change.body);
  // reason: measured whether or not it adds a worker: whether it adds is decided inside the transaction, where a delegation
  // ended meanwhile makes it one that adds (BR-2526, #261); the stalls measured here also decide a conflict there (D-151)
  const cap = measure(ws, main.value);
  if (!cap.ok) return cap;
  let added = false;
  let busy: string[] = [];
  const result = ws.db.db.transaction((): Result<Delegation> => {
    const previous = delegation(ws.db, subject);
    const adds = !previous || previous.ended !== null;
    // reason: another session's live delegation that is not stalled is that session's work; delegating it again would run two workers on one change (BR-2526, D-151, P4)
    if (previous && previous.ended === null && previous.owner !== ws.actor && !cap.value.stalled.has(subject)) {
      ws.db.event(ws.actor, "delegation.refuse", subject, { reason: "conflict", worker: previous.worker, owner: previous.owner });
      return err("conflict", `${subject} is already delegated to ${previous.worker} by ${previous.owner}; it is not stalled. Delegate another change, or leave it to ${previous.owner}`);
    }
    // reason: the subagent of an implicit delegation already runs, so a busy machine is said, not refused (BR-2610, D-156 amending D-136)
    if (adds) {
      const no = refusal(ws, cap.value);
      if (no && implicit) busy = no.reasons;
      else if (no) {
        ws.db.event(ws.actor, "delegation.refuse", subject, no.detail);
        return err("refused", refusalMessage(subject, no.reasons));
      }
    }
    const claim = ws.db.db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(subject);
    // reason: an implicit delegation is made only when no live claim binds the change; a lapsed row is taken over by the start that follows (BR-2610, BR-2011)
    if (claim && claim.holder !== ws.actor && !isWorker(claim.holder) && !implicit) return err("conflict", `${subject} is claimed by ${claim.holder}`);
    const accepted = claim && claim.holder === previous?.acceptor;
    if (accepted && worker !== previous!.worker) return err("conflict", `${subject} is held by ${claim.holder}; canon work take it before changing the worker`);
    const d: Delegation = { subject, worker, owner: ws.actor, revision: revision.value, epoch: (previous?.epoch ?? 0) + 1, acceptor: accepted ? previous!.acceptor : null, manifest, taskHash, ended: null };
    ws.db.db.query("INSERT INTO delegations(subject,worker,owner,revision,epoch,acceptor,manifest,task_hash) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET worker=excluded.worker,owner=excluded.owner,revision=excluded.revision,epoch=excluded.epoch,acceptor=excluded.acceptor,manifest=excluded.manifest,task_hash=excluded.task_hash,ended=NULL")
      .run(subject, worker, d.owner, d.revision, d.epoch, d.acceptor, JSON.stringify(manifest), taskHash);
    if (claim?.holder === ws.actor) ws.db.db.query("DELETE FROM claims WHERE subject = ? AND holder = ?").run(subject, ws.actor);
    added = adds;
    const missing = adds ? unmeasured(cap.value) : [];
    ws.db.event(ws.actor, previous ? "delegation.update" : "delegation.create", subject, { ...d, ...(previous ? { previous } : {}), ...(missing.length ? { unmeasured: missing } : {}), ...(implicit ? { implicit: true, by: implicit.by } : {}) });
    return ok(d);
  }).immediate();
  if (!result.ok) return result;
  if (added) for (const line of unmeasuredLines(cap.value)) say(line);
  if (busy.length > 0) say(`machine busy: ${busy.join("; ")}; ${subject} was started anyway because subagent ${worker} already runs (BR-2610); start no more subagents until it falls (canon work due)`);
  for (const line of delegationNotice(ws.db, subject)) say(line);
  for (const line of startNotices(ws, subject, true)) say(line);
  say(`contract: ${manifest.map((i) => `${i.id ?? i.path} ${i.hash}`).join(", ")}; task ${taskHash}`);
  const hooks = config.hooks as { after_land?: string | string[] } | undefined;
  const afterLand = hooks?.after_land;
  // reason: match the same configured hooks as startTrailingReview, including quoted script paths (BR-2497).
  if (!(Array.isArray(afterLand) ? afterLand : [afterLand ?? ""]).some((c) => c.includes("scripts/code-review.ts"))) say("design-gap review: not configured");
  return result;
}
