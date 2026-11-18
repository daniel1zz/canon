import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../workspace.ts";
import { mainCorpus } from "../session/session.ts";
import { delegation } from "./records.ts";
import { isWorker } from "./worker.ts";
import { blob } from "./delegate.ts";

/**
 * Rule text a worker proposes for its design owner (BR-2524, D-135, #254): the whole rule file, copied from main and edited
 * in place, under canon/proposals/<C-n>/<BR-n>.md on the change's branch. It is no design document (BR-2501), so a worker
 * may write it; only the design owner applies it to the rule.
 */
export const PROPOSALS_DIR = "canon/proposals";
/** The front matter key that records the blob of the rule on main the proposal was copied from. */
const BASE_KEY = "proposed_from";

export interface Proposal {
  readonly id: string;
  /** Repository-relative path of the proposal file. */
  readonly path: string;
}

/** The proposals of `change` in the checkout at `root`, by rule id. */
export function proposalsOf(root: string, change: string): Proposal[] {
  const dir = join(root, PROPOSALS_DIR, change);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[A-Z][A-Z0-9]*-\d+\.md$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => ({ id: n.slice(0, -3), path: `${PROPOSALS_DIR}/${change}/${n}` }));
}

/** The rule `id` on main: its path and blob there. */
function ruleOnMain(ws: Workspace, id: string): Result<{ path: string; blob: string }> {
  const corpus = mainCorpus(ws);
  if (!corpus.ok) return corpus;
  const doc = corpus.value.docs.find((d) => d.kind === "rule" && d.id === id);
  if (!doc) return err("not_found", `${id} is not a rule on ${ws.config.main}; a proposal starts from a rule main has (a new rule goes back to the design owner with canon work need-design)`);
  const blob = git(ws.primary, "rev-parse", `${ws.config.main}:${doc.path}`);
  if (!blob.ok) return err("io", blob.error.message);
  return ok({ path: doc.path, blob: blob.value.trim() });
}

/** `canon rule propose <BR-n>` (BR-2524): copies the rule as main has it into the change's proposal file, recording its blob. */
export function proposeRule(ws: Workspace, change: string, id: string): Result<Proposal> {
  const rule = ruleOnMain(ws, id);
  if (!rule.ok) return rule;
  const path = `${PROPOSALS_DIR}/${change}/${id}.md`;
  const full = join(ws.root, path);
  if (existsSync(full)) return err("conflict", `${path} already exists: edit it, or delete it to start again from main`);
  // reason: read byte for byte, not through the trimming git wrapper, so the applied rule ends exactly as main's does (BR-2524)
  const raw = blob(ws, ws.config.main, rule.value.path)?.toString();
  if (raw === undefined) return err("io", `cannot read ${rule.value.path} on ${ws.config.main}`);
  if (!raw.startsWith("---\n")) return err("invalid", `${rule.value.path} on ${ws.config.main} has no front matter`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${BASE_KEY}: ${rule.value.blob}\n${raw.slice(4)}`);
  return ok({ id, path });
}

export interface Applied {
  readonly id: string;
  readonly rulePath: string;
  readonly diff: string;
}

/**
 * `canon rule apply <C-n> [BR-n ...]` (BR-2524): the design owner writes each proposal, without its base line, over the
 * rule as main has it, and deletes the proposal. All or none: a proposal whose rule changed on main since it was copied
 * refuses the whole call (conflict), so nothing is half applied.
 */
export function applyProposals(ws: Workspace, change: string, only: readonly string[]): Result<Applied[]> {
  if (isWorker(ws.actor)) return err("refused", `${change}: a worker cannot apply proposals; its design owner applies them after canon work take (BR-2524)`);
  const d = delegation(ws.db, change);
  if (d && !d.ended) return err("refused", `${change} is delegated to ${d.worker}; its design owner ${d.owner} takes it back first (canon work take ${change}), then applies the proposals`);
  const all = proposalsOf(ws.root, change);
  const missing = only.filter((id) => !all.some((p) => p.id === id));
  if (all.length === 0 || missing.length > 0) return err("not_found", `${change}: no proposal ${missing.length > 0 ? `for ${missing.join(", ")} ` : ""}under ${PROPOSALS_DIR}/${change}/ in ${ws.root}`);
  const chosen = only.length > 0 ? all.filter((p) => only.includes(p.id)) : all;
  const plans: { p: Proposal; rulePath: string; text: string }[] = [];
  const stale: string[] = [];
  for (const p of chosen) {
    const raw = readFileSync(join(ws.root, p.path), "utf8");
    const m = new RegExp(`^---\\n${BASE_KEY}: ([0-9a-f]+)\\n`).exec(raw);
    if (!m) return err("invalid", `${p.path} has no ${BASE_KEY} line after its opening ---; make proposals with canon rule propose`);
    const rule = ruleOnMain(ws, p.id);
    if (!rule.ok) return rule;
    if (rule.value.blob !== m[1]) stale.push(p.id);
    plans.push({ p, rulePath: rule.value.path, text: `---\n${raw.slice(m[0].length)}` });
  }
  if (stale.length > 0) return err("conflict", `${stale.join(", ")} changed on ${ws.config.main} since proposed: nothing applied; have the worker propose again from main, or merge by hand`);
  const out: Applied[] = [];
  for (const { p, rulePath, text } of plans) {
    mkdirSync(dirname(join(ws.root, rulePath)), { recursive: true });
    writeFileSync(join(ws.root, rulePath), text);
    rmSync(join(ws.root, p.path));
    const diff = git(ws.root, "diff", "--no-color", "--", rulePath);
    out.push({ id: p.id, rulePath, diff: diff.ok ? diff.value : "" });
  }
  const dir = join(ws.root, PROPOSALS_DIR, change);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  ws.db.event(ws.actor, "proposal.apply", change, { rules: out.map((a) => a.id) });
  return ok(out);
}

/** The line a design request adds for the change's proposals, so the design owner sees them (BR-2524); empty with none. */
export function proposalNotice(root: string, change: string): string {
  const ps = proposalsOf(root, change);
  return ps.length === 0 ? "" : `\n\nProposed rule text (apply with canon rule apply ${change} after canon work take): ${ps.map((p) => p.path).join(", ")}`;
}
