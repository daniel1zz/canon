import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { stripCode, type Corpus, type Doc, type Rule } from "../documents/model.ts";
import { idsIn } from "../documents/types.ts";
import { contextFor, renderContext } from "../query/query.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { LESSONS_SECTION, section } from "../documents/templates.ts";

/**
 * AI review of rule and decision text, the one place the data showed AI judgment pays (spec/ADR rejects
 * 15/15 real). It sees the whole domain each changed rule belongs to, not a slice, and runs on the exact
 * tree that is landing. The reviewer is any command: prompt on stdin, JSON verdict on stdout.
 */
export interface ReviewVerdict {
  readonly verdict: "ok" | "block";
  readonly findings: readonly string[];
  /** Per rule asked about in `# Wording judgements`, what the reviewer answered (BR-2239); absent when it gave none. */
  readonly wording?: Readonly<Record<string, string>>;
}

/** A rule whose 规则 section changed while its examples did not, for the review to judge wording or behaviour (BR-2239, BR-2243). */
export interface WordingQuestion {
  readonly id: string;
  readonly title: string;
  /** The 规则 section of the version that passed before, and of the current version. */
  readonly before: string;
  readonly after: string;
  readonly examples: string;
}

/** A rule or decision file the landing deletes, with the text it had on main. */
export interface DeletedDoc {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

export interface ReviewExtras {
  readonly deleted?: readonly DeletedDoc[];
  /** Domains whose README the landing changes; the review sees each whole domain. */
  readonly readmes?: readonly string[];
  /** Domain READMEs the landing deletes, with the text they had on main. */
  readonly deletedReadmes?: readonly { readonly path: string; readonly text: string }[];
  /** The change this landing belongs to; the review reads its lessons (BR-2162). */
  readonly change?: Doc | undefined;
  /** Rules the closing change recorded as wording-only edits; the review must judge each (BR-2239). */
  readonly wording?: readonly WordingQuestion[];
}

export function reviewPrompt(root: string, corpus: Corpus, changed: readonly Doc[], extras: ReviewExtras = {}): string {
  const parts: string[] = [
    "You review changes to a project's rules and decisions. Rules are the current truth of what the product must do; decisions record why.",
    "Block only for: a rule that contradicts another active rule (in any domain: see the rule index) or an accepted decision; a rule a test cannot decide (vague, no boundary, examples that do not pin the boundary); a decision without the options it rejected.",
    "A changed decision that replaces only part of an accepted decision must list it in `amends:` (one that replaces a whole decision uses `supersedes:`); block a decision that says it changes part of another decision without listing it in `amends:`.",
    "Do not block for wording, style or formatting.",
    "One rule is one trigger (one command, event or kind of input) and one outcome (D-5). The error cases, exit codes and boundaries of the same trigger belong in that rule as examples, and a definition table (such as a list of exit codes) is one rule: do not suggest splitting those. Suggest a split only when a rule covers two different triggers, or two outcomes that could change independently; never block for it.",
    "Write the findings in the language the documents are written in.",
    // reason: turning a lesson into a mechanism needs the owner's confirmation; the review only reminds, never blocks (BR-2162, D-24)
    "When the change's lessons section is shown below, add a note (never block for it) naming the change id: for a lesson marked text-only (只靠文字) without a reason although a rule, check or command could enforce it; and for a lesson whose mechanism is a rule, check or command this landing adds (in the changed documents) when the lesson does not say the owner confirmed it.",
    extras.wording?.length
      ? 'Answer with JSON only: {"verdict":"ok"|"block","findings":["<one sentence each, naming the id>"],"wording":{"<rule id>":"wording"|"behaviour"}}, with one wording entry per rule under # Wording judgements'
      : 'Answer with JSON only: {"verdict":"ok"|"block","findings":["<one sentence each, naming the id>"]}',
    "",
  ];
  if (extras.wording?.length) {
    // reason: the close commit recorded these as wording-only edits; only this independent judgement lets them keep the earlier pass (BR-2239, D-32)
    parts.push(
      "# Wording judgements",
      "",
      'Each rule below changed only its 规则 section since the version that passed; its examples are the same. Answer "wording" when the edit changes no requirement (the product must do exactly what it had to before, for every input), "behaviour" when it adds, removes or changes any requirement, condition or boundary. When unsure, answer "behaviour". This judgement does not affect the verdict.',
      "",
    );
    for (const q of extras.wording) parts.push(`## ${q.id} ${q.title}

### 规则 before

${q.before.trim()}

### 规则 now

${q.after.trim()}

### 例子 (unchanged)

${q.examples.trim()}
`);
  }
  parts.push("# Changed documents (new text)");
  for (const d of changed) {
    // reason: the body has no front matter, so the reviewer could not see what a decision supersedes or amends (BR-2141)
    const links = d.kind === "decision" ? [...(d.supersedes ? [`supersedes: ${d.supersedes}`] : []), ...(d.amends.length ? [`amends: ${d.amends.join(", ")}`] : [])] : [];
    parts.push(`## ${d.id} ${d.title} (${d.kind}${"status" in d ? `, ${d.status}` : ""})\n\n${links.map((l) => `${l}\n`).join("")}${links.length ? "\n" : ""}${d.body.trim()}\n`);
  }
  const change = extras.change;
  if (change?.kind === "change") {
    const lessons = section(change.body, LESSONS_SECTION);
    if (lessons !== undefined) parts.push(`# Lessons of ${change.id} ${change.title} (the change this landing belongs to)\n\n${lessons.trim()}\n`);
  }
  if (extras.deleted?.length || extras.deletedReadmes?.length) {
    parts.push("# Deleted documents (text on main before this landing; deleting a rule removes a behaviour the product promised, retiring it keeps the record)");
    for (const d of extras.deleted ?? []) parts.push(`## ${d.id} — deleted ${d.path}\n\n${d.text.trim()}\n`);
    for (const r of extras.deletedReadmes ?? []) parts.push(`## deleted domain README ${r.path}\n\n${r.text.trim()}\n`);
  }
  if (extras.readmes?.length) parts.push(`# Domain READMEs changed: ${extras.readmes.join(", ")} (their new text is in the current context below)`);
  const seen = new Set<string>();
  for (const name of [...new Set((extras.readmes ?? []).map((n) => n.split("/")[0]!))]) {
    seen.add(name);
    parts.push(`# Current context for ${name}\n\n${renderContext(root, contextFor(corpus, name), { full: true })}`);
  }
  for (const d of changed) {
    // reason: the review reads the whole top-level domain, so a contradiction across its subdomains is still seen (BR-2113)
    const target = d.kind === "rule" ? d.domain.split("/")[0]! : d.id;
    if (seen.has(target)) continue;
    seen.add(target);
    parts.push(`# Current context for ${target}\n\n${renderContext(root, contextFor(corpus, target), { full: true })}`);
  }
  // reason: a deletion affects the domain it leaves, so the review sees what remains there (BR-2009, #74):
  // a deleted rule's top-level domain, and the top-level domains of the rules a deleted decision named on main
  for (const top of deletedDomains(corpus, extras.deleted ?? [])) {
    if (seen.has(top)) continue;
    seen.add(top);
    parts.push(`# Current context for ${top}\n\n${renderContext(root, contextFor(corpus, top), { full: true })}`);
  }
  // reason: planned rules constrain execution too, so a contradiction with one is found as well (BR-2036, BR-2235)
  const index = corpus.docs.filter((d) => d.kind === "rule" && d.status !== "retired");
  parts.push(`# Rule index (every active and planned rule, all domains)\n\n${index.map((r) => `- ${r.id} [${r.kind === "rule" ? r.domain : ""}]${r.kind === "rule" && r.status === "planned" ? " [规划中]" : ""} ${r.title}`).join("\n")}`);
  const accepted = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted");
  if (accepted.length) parts.push(`# Accepted decisions\n\n${accepted.map((d) => `- ${d.id} ${d.title}`).join("\n")}`);
  return parts.join("\n");
}

/** Top-level domains, still in the corpus, that the deleted documents belonged to or named. */
function deletedDomains(corpus: Corpus, deleted: readonly DeletedDoc[]): string[] {
  const out = new Set<string>();
  const exists = (name: string) => corpus.domains.some((d) => d.name === name);
  for (const d of deleted) {
    const m = d.path.match(/^canon\/rules\/(.+)\/[^/]+$/);
    if (m) {
      if (exists(m[1]!.split("/")[0]!)) out.add(m[1]!.split("/")[0]!);
      continue;
    }
    const named = idsIn(corpus.types, stripCode(d.text));
    for (const r of corpus.docs.filter((x): x is Rule => x.kind === "rule" && named.has(x.id))) if (exists(r.domain.split("/")[0]!)) out.add(r.domain.split("/")[0]!);
  }
  return [...out];
}

/** How a review run is bounded: its time limit, and where a signal handler finds it to stop it (BR-2296). */
export interface ReviewLimits {
  readonly timeoutMs: number;
  /** Called with the running review's stopper when it starts, and with undefined when it has ended. */
  readonly track?: (running: { kill(): void } | undefined) => void;
}

export async function runReview(command: string, cwd: string, prompt: string, limits: ReviewLimits): Promise<Result<ReviewVerdict>> {
  // reason: its own process group, so a timeout or a signal stops the reviewer's children too (claude under sh), not only sh (BR-2296)
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", detached: true });
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // reason: the group is already gone; nothing is left to stop
    }
  };
  limits.track?.({ kill });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, limits.timeoutMs);
  let out: string, errText: string, code: number;
  try {
    [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    clearTimeout(timer);
    limits.track?.(undefined);
  }
  if (timedOut) return err("io", `review command did not finish within ${limits.timeoutMs / 60_000} minute(s) (review_timeout_minutes) and was stopped with its children`);
  if (code !== 0) return err("io", `review command exited ${code}: ${errText.trim().slice(0, 500)}`);
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return err("invalid", `review command printed no JSON: ${out.trim().slice(0, 300)}`);
  try {
    const v = JSON.parse(match[0]) as { verdict?: unknown; findings?: unknown };
    if (v.verdict !== "ok" && v.verdict !== "block") return err("invalid", `review verdict must be "ok" or "block", got ${JSON.stringify(v.verdict)}`);
    const findings = Array.isArray(v.findings) ? v.findings.map(String) : [];
    const w = (v as { wording?: unknown }).wording;
    const wording = w !== null && typeof w === "object" && !Array.isArray(w) ? Object.fromEntries(Object.entries(w as Record<string, unknown>).map(([k, x]) => [k, String(x)])) : undefined;
    return ok({ verdict: v.verdict, findings, ...(wording ? { wording } : {}) });
  } catch (e) {
    return err("invalid", `review JSON does not parse: ${(e as Error).message}`);
  }
}

/** Text every session reads at start, gathered from the tree that is landing (BR-2143). */
export interface StandingText {
  /** The configured instruction files that exist, path and whole text. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** Each project skill's front-matter description, the only part of a skill loaded into every session. */
  readonly skills: readonly { readonly path: string; readonly description: string }[];
}

export const SKILL_FILE = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;

export function standingText(root: string, instructions: readonly string[]): StandingText {
  const files = instructions.filter((p) => existsSync(join(root, p))).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const dir = join(root, ".claude", "skills");
  const skills: { path: string; description: string }[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = `.claude/skills/${name}/SKILL.md`;
    if (!existsSync(join(root, path))) continue;
    const front = readFileSync(join(root, path), "utf8").match(/^---\n([\s\S]*?)\n---/);
    let description: string;
    try {
      const meta = front ? (parse(front[1]!) as { description?: unknown } | null) : null;
      description = typeof meta?.description === "string" ? meta.description : "(no description)";
    } catch (e) {
      description = `(front matter does not parse: ${(e as Error).message.split("\n")[0]})`;
    }
    skills.push({ path, description });
  }
  return { files, skills };
}

export function duplicatePrompt(changed: readonly string[], standing: StandingText, guide: string | undefined): string {
  const parts: string[] = [
    "You review the standing instructions of a project: text loaded into every AI coding session at start. The same requirement written in two places drifts apart, and the reader no longer knows which one holds.",
    "Block when one requirement (an instruction, a condition or a qualifier) is stated in two standing texts below, or twice in one of them, in any wording or language, and at least one of the two places is in a changed file.",
    "Do not block for: a one-line pointer to where a requirement is stated; a project-specific qualifier added to a general requirement stated elsewhere; facts or descriptions that are not requirements; wording, style or formatting.",
    "Each finding names both places (file or source, and the sentence) and which one to keep.",
    "Write the findings in the language the changed text is written in.",
    'Answer with JSON only: {"verdict":"ok"|"block","findings":["<one sentence each>"]}',
    "",
    `# Changed in this landing: ${changed.join(", ")}`,
  ];
  if (guide !== undefined) parts.push(`# canon brief workflow guide (printed at the start of every session)\n\n${guide.trim()}\n`);
  for (const f of standing.files) parts.push(`# ${f.path} (instruction file, loaded whole)\n\n${f.text.trim()}\n`);
  if (standing.skills.length) parts.push(`# Skill descriptions (each loaded into every session)\n\n${standing.skills.map((s) => `- ${s.path}: ${s.description}`).join("\n")}`);
  return parts.join("\n");
}
