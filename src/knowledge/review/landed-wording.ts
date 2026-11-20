import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { parseDocFile } from "../documents/docfile.ts";
import type { Change, Corpus, PassRecord } from "../documents/model.ts";
import type { Say, Workspace } from "../../work/workspace.ts";
import { unconfirmedWording, wordingQuestions } from "../../work/execution/landing.ts";
import { passedWording, reviewKey } from "../../work/land/checks/review-reuse.ts";
import { couldNotRun } from "../../work/land/checks/review-scope.ts";
import type { reviewTree } from "../../work/land/checks/review-tree.ts";
import { recordFindings } from "./findings/findings.ts";
import { judgeWording, retryPrompt, runReview, unparsedTexts, wordingPrompt, type ReviewLimits, type WordingQuestion, type WordingWhy } from "./review.ts";

/**
 * The wording judgement after a landing (BR-2239, D-141): the landing that closed a change whose close commit records rules as
 * wording-only edits (BR-2243) asks the review command, in the background, whether each edit kept the behaviour. The landing
 * has already happened; a rule the review does not confirm becomes an open review finding on it, naming the change, for the
 * main agent to settle like any other finding (BR-2442). Nothing here refuses or moves main.
 */

/** The criterion of the finding a rule not confirmed as a wording-only edit opens (BR-2239). */
export const WORDING_CRITERION = "wording";

/**
 * The wording questions of the landing `base..head` in the checkout `wt` at `head`: only when this landing closed `change`
 * (done at `head`, not done at `base`) and its close commit records wording-only edits. Empty otherwise.
 */
export function landedWordingQuestions(wt: string, base: string, head: string, corpus: Corpus, change: string | null): WordingQuestion[] {
  if (change === null) return [];
  const doc = corpus.docs.find((d): d is Change => d.kind === "change" && d.id === change);
  if (!doc || doc.status !== "done") return [];
  const before = git(wt, "show", `${base}:${doc.path}`);
  const parsed = before.ok ? parseDocFile(before.value, doc.path) : undefined;
  if (parsed?.ok && parsed.value.meta["status"] === "done") return [];
  const records: Record<string, PassRecord> = {};
  for (const [id, r] of Object.entries(doc.passes)) if (r.wording) records[id] = r;
  return wordingQuestions(wt, head, corpus, change, records);
}

/** The text of the finding a rule not confirmed as wording-only opens; it names the rule, so it is attached to it (BR-2434). */
export function wordingFindingText(id: string, change: string | null, answer: string | undefined, why: WordingWhy | undefined): string {
  const said = answer === "behaviour" && why ? `the review answered behaviour: “${why.quote}” requires ${why.requires || "(not said)"}` : `the review answered ${answer === undefined ? "nothing" : JSON.stringify(answer)}`;
  return `${id}: ${change ?? "this landing"} recorded it as a wording-only edit, but ${said}. Execute it as a behaviour change: change a line in a running test whose title names ${id}, or for a rule with untested:, a line under ## 验收, in a change that lists it in rules: (BR-2239)`;
}

export interface WordingJob {
  readonly change: string | null;
  readonly head: string;
  /** The main commit whose review command runs it, for the message when it cannot run. */
  readonly reviewerAt: string;
  readonly at: "before" | "main";
}

/**
 * Asks the wording judgement of `questions` and records it (BR-2239): reused from the newest judgement of the same prompt and
 * command that confirmed every rule; an answer canon cannot read is asked once more; every rule not confirmed opens a finding.
 * An error means the judgement could not run, and the review after the landing fails as when the rule review cannot run.
 */
export async function judgeLandedWording(ws: Workspace, job: WordingJob, say: Say, reviewer: string, limits: ReviewLimits, tree: ReturnType<typeof reviewTree>, questions: readonly WordingQuestion[]): Promise<Result<void>> {
  const ids = questions.map((q) => q.id);
  say(`wording judgement: ${ids.join(", ")}`);
  const prompt = wordingPrompt(questions);
  const hash = reviewKey("land", reviewer, 0, [prompt]);
  const earlier = passedWording(ws.db, hash);
  let answers: Readonly<Record<string, string>> | undefined;
  let why: Readonly<Record<string, WordingWhy>> | undefined;
  let event: number;
  if (earlier && unconfirmedWording(questions, earlier.wording).length === 0) {
    say(`wording judgement: reused event ${earlier.event} for the same question; the review command was not run`);
    answers = earlier.wording;
    event = earlier.event;
  } else {
    const at = tree.get();
    if (!at.ok) return at;
    let lastOut = "";
    const ask = async (text: string) => {
      await limits.slots?.take();
      try {
        return await runReview(reviewer, at.value, text, { ...limits, capture: (out: string) => (lastOut = out) });
      } finally {
        limits.slots?.give();
      }
    };
    let run = await ask(prompt);
    // reason: an answer canon cannot read is the reviewer's failure, not a verdict; it is asked once more with the format error (BR-2239, #227)
    const retried = !run.ok && run.error.code === "invalid";
    if (!run.ok && retried) {
      say(`wording judgement: the answer could not be read (${run.error.message.slice(0, 200)}); asking the review command once more`);
      run = await ask(retryPrompt(prompt, run.error.message));
      const unread = !run.ok && run.error.code === "invalid" ? run.error.message : undefined;
      const texts = unread !== undefined ? unparsedTexts(lastOut) : [];
      if (texts.length > 0) {
        ws.db.event(ws.actor, "review.unparsed", job.change, { docs: ids, texts, commit: job.head });
        return err("invalid", [`the wording judgement of ${ids.join(", ")} answered twice in a form canon cannot read (${(unread ?? "").slice(0, 200)}); what the reviewer wrote:`, ...texts.map((t) => `  - ${t}`)].join("\n"));
      }
    }
    if (!run.ok) return err("io", couldNotRun("wording", retried ? `${run.error.message} (asked twice; neither answer could be read)` : run.error.message, at.value, job.reviewerAt, job.at));
    // reason: a behaviour answer must quote the sentence that makes the difference; without one it counts as wording (BR-2239, #256)
    const judged = judgeWording(questions, run.value.wording, run.value.wordingWhy);
    for (const id of judged.unquoted) say(`wording judgement: ${id}: behaviour without a quote from the rule: treated as wording`);
    answers = judged.answers;
    why = run.value.wordingWhy;
    event = ws.db.event(ws.actor, "review.wording", job.change, { docs: ids, wording: answers, ...(why ? { why } : {}), ...(judged.unquoted.length > 0 ? { unquoted: judged.unquoted } : {}), hash, commit: job.head });
  }
  const unconfirmed = new Set(unconfirmedWording(questions, answers));
  for (const id of ids) if (!unconfirmed.has(id)) say(`wording judgement: ${id}: wording; its earlier pass carries over`);
  if (unconfirmed.size === 0) return ok(undefined);
  const findings = [...unconfirmed].map((id) => ({ criterion: WORDING_CRITERION, text: wordingFindingText(id, job.change, answers?.[id], why?.[id]) }));
  const recorded = recordFindings(ws.db, { findings, reviewed: [...unconfirmed], change: job.change, event, sha: job.head });
  if (!recorded.ok) return err("invalid", `the wording judgement's findings could not be recorded: ${recorded.error.message}`);
  const opened = [...recorded.value.opened, ...recorded.value.existing];
  say(`wording judgement: ${[...unconfirmed].join(", ")} not confirmed as wording-only edits; recorded as open review finding(s) ${opened.map((i) => `#${i}`).join(", ")} on them: execute each as a behaviour change, then canon finding close <n> --fixed <commit> --reason "<why>"`);
  for (const f of findings) say(`  [${f.criterion}] ${f.text}`);
  return ok(undefined);
}

