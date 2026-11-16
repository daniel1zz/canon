import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import type { DelegationSnapshot } from "../../work/land/checks/delegation.ts";

/**
 * Post-land code review (C-2, D-1): runs as an `after_land` hook, never blocks. Unlike the old per-plan
 * reviews, it reads the whole landed diff AND the full current text of every changed file (BR-2070), and it
 * files one GitHub issue per root cause: a finding whose root cause already has an open issue becomes a
 * comment there, not a new issue (BR-2072). Every finding must say where and under which input or timing it
 * fails (BR-2071); vaguer ones are dropped rather than filed.
 *
 * The AI and GitHub are commands (CANON_CODE_REVIEW_AI, CANON_GH) so tests can stand in for both.
 */
export const LABEL = "canon-review";
/** The label of an issue a design-gap finding opens for the landing's design owner (BR-2503). */
export const DESIGN_GAP_LABEL = "canon-design-gap";
export const DESIGN_GAP = "design-gap";
const MAX_FILE_BYTES = 100_000;

export interface Finding {
  /** One of the kinds the review asks for: `security`, `concurrency`, or `design-gap` when the range has worker landings (BR-2503). */
  readonly kind: string;
  readonly title: string;
  readonly root_cause: string;
  readonly file: string;
  readonly line: number;
  readonly scenario: string;
  /** Number of an open issue the AI says has the same root cause. */
  readonly existing: number | null;
  /** A design-gap's worker landing: the id of its land.ok event (BR-2503). */
  readonly landing?: number;
}

/** A landing of the range that a worker made, with the delegation snapshot its land.ok records (BR-2501, BR-2503). */
export interface WorkerLanding {
  /** The id of the land.ok event. */
  readonly event: number;
  readonly sha: string;
  /** Where the landing's own diff starts: the land.ok's base. */
  readonly base: string;
  readonly change: string | null;
  readonly delegation: DelegationSnapshot;
}

/** What the reviewer is given for a worker landing that changed files outside canon/ (BR-2503). */
export interface WorkerContext extends WorkerLanding {
  /** Each contract item's full text at the snapshot's design revision. */
  readonly contract: readonly { name: string; path: string; text: string }[];
  /** The landing's own diff, its base to its commit. */
  readonly diff: string;
}

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface Env {
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  readonly change: string;
  readonly ai: string;
  readonly gh: string;
  readonly say: (line: string) => void;
  /** The change a finding's line belongs to, when it can be told (BR-2210). */
  readonly owner?: (file: string, line: number) => string | undefined;
  /** The worker landings of the range (BR-2503); the ones that changed only canon/ are left out of the review. */
  readonly workers?: readonly WorkerLanding[];
}

/** The files the landing added, changed or renamed outside canon/, with their full text at HEAD; deleted ones are only in the diff. */
export function changedFiles(e: Env): Result<{ path: string; text: string }[]> {
  const names = git(e.cwd, "diff", "--name-only", "--diff-filter=d", e.base, e.head); // everything but deletions (BR-2070)
  if (!names.ok) return names;
  const out: { path: string; text: string }[] = [];
  for (const path of names.value.split("\n").filter((p) => p !== "" && !p.startsWith("canon/"))) {
    const text = git(e.cwd, "show", `${e.head}:${path}`);
    if (!text.ok || text.value.length > MAX_FILE_BYTES || text.value.includes("\u0000")) continue;
    out.push({ path, text: text.value });
  }
  return ok(out);
}

/**
 * The worker landings of the range that changed files outside canon/, with each contract item's text at the snapshot's
 * design revision (not at main now) and the landing's own diff (BR-2503).
 */
export function workerContexts(cwd: string, workers: readonly WorkerLanding[]): Result<WorkerContext[]> {
  const out: WorkerContext[] = [];
  for (const w of workers) {
    const code = git(cwd, "diff", "--name-only", w.base, w.sha, "--", ".", ":(exclude)canon");
    if (!code.ok) return code;
    // reason: business choices are in code; a worker landing that changed only canon/ has none to look for (BR-2503)
    if (code.value === "") continue;
    const diff = git(cwd, "diff", w.base, w.sha);
    if (!diff.ok) return diff;
    const contract: { name: string; path: string; text: string }[] = [];
    for (const item of w.delegation.contract) {
      const text = git(cwd, "show", `${w.delegation.revision}:${item.path}`);
      if (!text.ok) return err("io", `contract item ${item.id ?? item.path} of land.ok ${w.event} (${w.change ?? w.sha.slice(0, 9)}) is not readable at its design revision ${w.delegation.revision.slice(0, 9)}: ${text.error.message}`);
      contract.push({ name: item.id ?? item.path, path: item.path, text: text.value });
    }
    out.push({ ...w, contract, diff: diff.value });
  }
  return ok(out);
}

/** The design-gap part of the prompt: what to look for and, per worker landing, its contract and its own diff (BR-2503). */
function designGapPrompt(workers: readonly WorkerContext[]): string[] {
  return [
    "",
    "# Design gaps of worker landings",
    "",
    "Each landing below was made by a worker that implements a design its design owner fixed at delegation (the contract list). Besides security and concurrency, look in each of these landings' own diff for a design gap (kind `design-gap`): the diff fixes a business choice that none of the landing's contract items states. A business choice is a result users can see, what happens on an error, the format of stored data, or an external interface (a command, flag, output, file format or API). Internal naming and how functions are split are NOT business choices; never report them. A choice that any contract item states, anywhere in its full text below, is not a gap. Judge only against the contract text given here, as it was at the landing's design revision, not against anything newer.",
    "A design-gap finding names its landing by the land.ok event id given in that landing's heading (`landing`); `file` and `line` point at the code that makes the choice, `scenario` says the choice (on which input, what result), `root_cause` says which contract item would have to state it and that none does.",
    ...workers.flatMap((w) => [
      "",
      `## Worker landing: land.ok ${w.event}, commit ${w.sha.slice(0, 9)}, change ${w.change ?? "(none)"}, landed by ${w.delegation.lander} (design owner ${w.delegation.owner}, epoch ${w.delegation.epoch}, design revision ${w.delegation.revision.slice(0, 9)})`,
      ...w.contract.map((c) => `\n### Contract item ${c.name} (${c.path}) at design revision ${w.delegation.revision.slice(0, 9)}\n\n${c.text}`),
      "",
      `### Diff of this landing (${w.base.slice(0, 9)}..${w.sha.slice(0, 9)})`,
      "",
      w.diff,
    ]),
  ];
}

export function reviewPrompt(diff: string, files: readonly { path: string; text: string }[], open: readonly OpenIssue[], workers: readonly WorkerContext[] = []): string {
  const gaps = workers.length > 0;
  return [
    `You review code that has just landed on main. Look ONLY for security problems and concurrency problems (races, lost updates, missing atomicity, unsafe shared state, deadlocks)${gaps ? ", and the design gaps of worker landings described under \"# Design gaps of worker landings\" below" : ""}. Ignore style, naming, performance and everything else.`,
    "Report a problem only when you can name the exact file and line, and the concrete input or interleaving of events under which it goes wrong. If you cannot, do not report it.",
    // reason: one criterion, whether normal operations lead to it; findings that need an abnormal setup grew code no real use needed (D-54)
    "Report only problems that normal operations lead to: the scenario must say who hits it in which normal operation. How a test could reproduce it does not decide: a race between two normal operations is real even when a test needs a barrier to force it. Do not report situations that need an abnormal setup or action (a user's wrapper around a system command, a non-default backend nobody uses, killing one specific process mid-step, hostile input that crosses no security boundary), unless the problem loses data, is a security problem, or breaks what the project promises (in canon's own repository, a promise P1 to P7 in canon/product.md, such as sessions overwriting each other or a broken main).",
    "Before reporting a problem, try once to disprove it: read the code that guards it, its callers and its tests. Report only what survives that attempt.",
    "Several symptoms of one root cause are ONE finding. If an open issue below already describes the same root cause, set `existing` to its number.",
    'Answer with JSON only: {"findings":[{"kind":"security"|"concurrency","title":"<short>","root_cause":"<one sentence>","file":"<path>","line":<n>,"scenario":"<who, in which normal operation, with which input or timing → wrong result>","existing":<issue number or null>}]}',
    ...(gaps ? ['A design gap is one more entry of the same list: {"kind":"design-gap","landing":<land.ok event id>,"title":"<short>","root_cause":"<which contract item would have to state it; none does>","file":"<path>","line":<n>,"scenario":"<the choice the diff makes: on which input, what result>"}'] : []),
    "",
    "# Diff of the landing",
    "",
    diff,
    "",
    "# Full current text of each changed file",
    ...files.map((f) => `\n## ${f.path}\n\n${f.text}`),
    "",
    "# Open issues already filed by this review",
    open.length ? open.map((i) => `- #${i.number} ${i.title}\n  ${i.body.split("\n").slice(0, 6).join("\n  ")}`).join("\n") : "(none)",
    ...(gaps ? designGapPrompt(workers) : []),
  ].join("\n");
}

/** How an issue names the review that filed it, as "found by the <WHO> of C-5" (BR-2210). */
const WHO = "post-land code review";
const CODE_KINDS = ["security", "concurrency"] as const;

/**
 * Parses the AI's answer; findings missing a file, a line or a scenario, or of another kind, are dropped (BR-2071).
 * A `design-gap` is kept only when it names the land.ok id of one of `workers`, the worker landings of the range (BR-2503).
 */
export function parseFindings(text: string, say: (line: string) => void, workers: ReadonlySet<number> = new Set()): Result<Finding[]> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return err("invalid", `the reviewer printed no JSON: ${text.trim().slice(0, 200)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch (e) {
    return err("invalid", `the reviewer's JSON does not parse: ${(e as Error).message}`);
  }
  const list = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return err("invalid", "the reviewer's JSON has no `findings` list");
  const out: Finding[] = [];
  for (const f of list as Record<string, unknown>[]) {
    const str = (k: string) => (typeof f[k] === "string" && (f[k] as string).trim() !== "" ? (f[k] as string).trim() : undefined);
    const kind = f["kind"];
    const line = typeof f["line"] === "number" ? f["line"] : Number(f["line"]);
    const [title, rootCause, file, scenario] = [str("title"), str("root_cause"), str("file"), str("scenario")];
    if (typeof kind !== "string" || !([...CODE_KINDS, DESIGN_GAP] as readonly string[]).includes(kind) || !title || !rootCause || !file || !scenario || !Number.isInteger(line) || line <= 0) {
      say(`dropped a finding without kind, file, line or scenario: ${JSON.stringify(f).slice(0, 200)}`);
      continue;
    }
    if (kind === DESIGN_GAP) {
      const raw = f["landing"];
      const landing = typeof raw === "number" ? raw : typeof raw === "string" && /^#?\d+$/.test(raw.trim()) ? Number(raw.trim().replace("#", "")) : NaN;
      if (!workers.has(landing)) {
        say(`dropped a design-gap finding that names no land.ok id of a worker landing in this range: ${JSON.stringify(f).slice(0, 200)}`);
        continue;
      }
      out.push({ kind, title, root_cause: rootCause, file, line, scenario, existing: null, landing });
      continue;
    }
    const existing = typeof f["existing"] === "number" ? f["existing"] : null;
    out.push({ kind, title, root_cause: rootCause, file, line, scenario, existing });
  }
  return ok(out);
}

/** The code review command when CANON_CODE_REVIEW_AI is not set (BR-2070): no tools, so the reviewer prints its answer (D-120). */
export const DEFAULT_CODE_REVIEW_AI = "claude -p --tools '' --output-format text";

export function run(cmd: string, args: readonly string[], cwd: string, stdin?: string): Result<string> {
  const r = Bun.spawnSync(["sh", "-c", `${cmd} "$@"`, "sh", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: new Blob([stdin ?? ""]) });
  if (r.exitCode !== 0) return err("io", `${cmd} ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 300)}`);
  return ok(r.stdout.toString());
}

export function openIssues(e: Env, label: string = LABEL): Result<OpenIssue[]> {
  const r = run(e.gh, ["issue", "list", "--state", "open", "--label", label, "--limit", "200", "--json", "number,title,body"], e.cwd);
  if (!r.ok) return r;
  return ok(JSON.parse(r.value || "[]") as OpenIssue[]);
}

/** An open issue with the same root cause: the one the AI named if it is really open, else one whose title matches. */
function sameRootCause(e: Env, f: Finding, open: readonly OpenIssue[], label: string): Result<number | null> {
  if (f.existing !== null && open.some((i) => i.number === f.existing)) return ok(f.existing);
  const r = run(e.gh, ["issue", "list", "--state", "open", "--label", label, "--search", `${f.title} in:title`, "--json", "number,title"], e.cwd);
  // reason: a failed search proves nothing about duplicates; filing anyway could open a second issue for one root cause (BR-2211)
  if (!r.ok) return r;
  const hits = JSON.parse(r.value || "[]") as { number: number; title: string }[];
  return ok(hits.find((h) => h.title.trim().toLowerCase() === f.title.trim().toLowerCase())?.number ?? null);
}

function body(e: Env, group: readonly Finding[], who: string): string {
  const f = group[0]!;
  const range = `${e.base.slice(0, 9)}..${e.head.slice(0, 9)}`;
  const files = [...new Set(group.map((g) => g.file))];
  return [
    `**${f.kind}**, found by the ${who} of ${e.change || "a landing"} (\`${range}\`).`,
    "",
    `Root cause: ${f.root_cause}`,
    "",
    ...group.map((g) => `- \`${g.file}:${g.line}\` (${e.owner?.(g.file, g.line) ?? "in range"}): ${g.scenario}`),
    "",
    ...files.map((file) => `Reproduce from: \`git diff ${e.base.slice(0, 9)} ${e.head.slice(0, 9)} -- ${file}\``),
  ].join("\n");
}

export interface ReviewReport {
  readonly created: readonly string[];
  readonly commented: readonly number[];
}

export function codeReview(e: Env): Result<ReviewReport> {
  const diff = git(e.cwd, "diff", e.base, e.head, "--", ".", ":(exclude)canon");
  if (!diff.ok) return diff;
  // reason: a landing that only deletes code, or only changes binary or oversized files, gives no full text
  // but is still a code change; only an empty diff outside canon/ means there is nothing to review (BR-2070, #71)
  if (diff.value.trim() === "") {
    e.say("no code changed; nothing to review");
    return ok({ created: [], commented: [] });
  }
  const files = changedFiles(e);
  if (!files.ok) return files;
  const workers = workerContexts(e.cwd, e.workers ?? []);
  if (!workers.ok) return workers;
  const open = openIssues(e);
  if (!open.ok) return open;
  const answer = run(e.ai, [], e.cwd, reviewPrompt(diff.value, files.value, open.value, workers.value));
  if (!answer.ok) return answer;
  const findings = parseFindings(answer.value, e.say, new Set(workers.value.map((w) => w.event)));
  if (!findings.ok) return findings;
  const code = findings.value.filter((f) => f.kind !== DESIGN_GAP);
  const gaps = findings.value.filter((f) => f.kind === DESIGN_GAP);
  return fileFindings(e, code, open.value, gaps.map((f) => ({ finding: f, landing: workers.value.find((w) => w.event === f.landing)! })));
}

/** A design-gap issue's body: the change, its lander, its design owner, the code location and the unstated choice (BR-2503). */
function gapBody(e: Env, f: Finding, w: WorkerLanding): string {
  const d = w.delegation;
  return [
    `**${DESIGN_GAP}**, found by the ${WHO} of ${e.change || "a landing"} (\`${e.base.slice(0, 9)}..${e.head.slice(0, 9)}\`).`,
    "",
    `Change: ${w.change ?? w.sha.slice(0, 9)}, landed by ${d.lander} (land.ok ${w.event}, commit ${w.sha.slice(0, 9)}, epoch ${d.epoch})`,
    `Design owner: ${d.owner}: decides whether to add a rule or change the code; not for the worker.`,
    `Design revision: ${d.revision.slice(0, 9)}; contract: ${d.contract.map((c) => c.id ?? c.path).join(", ")}`,
    "",
    `Unstated choice: ${f.scenario}`,
    `Not stated by the contract: ${f.root_cause}`,
    "",
    `- \`${f.file}:${f.line}\``,
    "",
    `Reproduce from: \`git diff ${w.base.slice(0, 9)} ${w.sha.slice(0, 9)} -- ${f.file}\``,
  ].join("\n");
}

/**
 * Files kept findings, one issue per root cause (BR-2072): a comment on an open issue labelled LABEL with the same
 * root cause, else a new issue with that label; prints "no findings" when there is nothing to file (BR-2070).
 */
function fileFindings(e: Env, findings: readonly Finding[], open: readonly OpenIssue[], gaps: readonly { finding: Finding; landing: WorkerLanding }[]): Result<ReviewReport> {
  // One root cause, one issue: findings of this run that share a root cause or an existing issue are grouped.
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const same = sameRootCause(e, f, open, LABEL);
    if (!same.ok) return same;
    const target = same.value;
    const key = target !== null ? `#${target}` : f.root_cause.toLowerCase().replace(/\s+/g, " ");
    groups.set(key, [...(groups.get(key) ?? []), { ...f, existing: target }]); // a number that is not an open issue is dropped
  }
  const created: string[] = [];
  const commented: number[] = [];
  for (const group of groups.values()) {
    const f = group[0]!;
    if (f.existing !== null) {
      const r = run(e.gh, ["issue", "comment", String(f.existing), "--body", body(e, group, WHO)], e.cwd);
      if (!r.ok) return r;
      commented.push(f.existing);
      e.say(`commented on #${f.existing}: ${f.title}`);
    } else {
      const r = run(e.gh, ["issue", "create", "--title", f.title, "--label", LABEL, "--body", body(e, group, WHO)], e.cwd);
      if (!r.ok) return r;
      created.push(r.value.trim());
      e.say(`created ${r.value.trim()}: ${f.title}`);
    }
  }
  // reason: one issue per design gap, for the design owner of the landing it names, never the worker (BR-2503)
  for (const { finding: f, landing } of gaps) {
    const r = run(e.gh, ["issue", "create", "--title", f.title, "--label", DESIGN_GAP_LABEL, "--body", gapBody(e, f, landing)], e.cwd);
    if (!r.ok) return r;
    created.push(r.value.trim());
    e.say(`created ${r.value.trim()}: ${f.title} (design owner ${landing.delegation.owner})`);
  }
  // reason: an empty after-land log must tell "reviewed, nothing found" from "never ran" (BR-2070)
  if (groups.size === 0 && gaps.length === 0) e.say("no findings");
  return ok({ created, commented });
}
