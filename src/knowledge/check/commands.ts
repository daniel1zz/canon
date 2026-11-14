import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { git } from "../../kernel/git.ts";
import { guideFor } from "../../invocation/guide.ts";
import { architectureHints } from "./architecture.ts";
import { backlogNotes, check, domainNameNotes, noteLine, staleReportNotes } from "./check.ts";
import { reportsFor } from "../../work/verify/changes.ts";
import { architectureBase, changeIdsOnBranches, listedBefore } from "../../work/session/inflight.ts";
import { budgetHint, sessionText, sizeLines } from "./session-text.ts";
import { REVIEW_NONE } from "../review/config-keys.ts";
import { reviewSettingsOn } from "../../work/land/checks/review-scope.ts";
import { thisWorkChanges } from "../review/preview.ts";
import { reviewSizeHints } from "../review/size-hint.ts";
import { testFilesFor } from "./tests.ts";
import { restatementLine } from "./restatement/restatement.ts";
import { workBase, workRestatements } from "./restatement/work.ts";
import { deferralNotes } from "./commitments.ts";

/** `canon check`: corpus integrity. */

/** The review mode and budget the landing will use: main's in a worktree, this checkout's on main (BR-2074, BR-2375). */
function reviewSizeSettings(ws: ReturnType<typeof workspace>): { review: string | undefined; budget: number } {
  if (ws.root === ws.primary) return { review: ws.config.review, budget: ws.config.reviewMaxPromptBytes };
  const main = must(git(ws.root, "rev-parse", "--verify", `${ws.config.main}^{commit}`));
  const on = must(reviewSettingsOn(ws.root, main));
  return { review: on.review, budget: on.reviewMaxPromptBytes };
}

const checkCmd = defineCommand({
  meta: { description: "Corpus integrity: files valid, ids unique, references resolve, rules and tests name each other" },
  args: { json: { type: "boolean" }, sizes: { type: "boolean", description: "Also write, on standard error, the bytes of text every session loads (BR-2256)" } },
  run({ args }) {
    const ws = workspace();
    const read = corpusOf(ws);
    const testFiles = must(testFilesFor(ws.root, ws.config));
    const reports = must(reportsFor(ws.db, ws.root, ws.config, read.corpus, testFiles));
    const input = { root: ws.root, ...read, testFiles, reports, branchChanges: must(changeIdsOnBranches(ws)), backlogBase: must(listedBefore(ws)), architecture: must(architectureBase(ws)) };
    const findings = check(input);
    // reason: a dangling id main already lists is said on stderr and never fails the check (BR-2150, #112)
    for (const n of backlogNotes(input)) console.error(noteLine(n));
    // reason: a domain named after a technical layer is a note too: renaming it is a judgement call, never a refusal (BR-2318)
    // reason: files changed by others since their last report still count by their older report, said once (BR-2345)
    for (const n of staleReportNotes(input)) console.error(noteLine(n));
    for (const n of domainNameNotes(input)) console.error(noteLine(n));
    const work = must(thisWorkChanges(ws, read.corpus));
    // reason: a restatement this work wrote is said and never fails the check; the rule review is what blocks it (BR-2403, D-84)
    if (work) for (const r of workRestatements(ws.root, must(workBase(ws.root, ws.config.main)), read.corpus, work.changed)) console.error(`note: ${restatementLine(r)}`);
    // reason: words that put a behaviour off are a guess, so they are said and never fail the check (BR-2470, D-112)
    if (work) for (const n of deferralNotes(ws.root, must(workBase(ws.root, ws.config.main)), work.changed)) console.error(n);
    // reason: domains the overview never named are old gaps, said and never refused; only a landing that adds one is refused (D-65, D-37)
    for (const h of architectureHints(input)) console.error(h);
    if (args.json) json(findings);
    else for (const f of findings) say(`${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
    if (!args.json) say(findings.length === 0 ? `ok: ${read.corpus.docs.length} documents, ${read.corpus.domains.length} domains` : `${findings.length} finding(s)`);
    // reason: sizes and the budget hint go to standard error so stdout and the exit code stay as BR-2189 says (BR-2256, BR-2257)
    const parts = sessionText(ws.root, guideFor(ws.root));
    if (args.sizes) for (const line of sizeLines(parts, ws.config.sessionTextBudget)) console.error(line);
    const hint = budgetHint(parts, ws.config.sessionTextBudget);
    if (hint) console.error(hint);
    // reason: a domain close to review_max_prompt_kb is said before a change to it is refused, and never fails the check (BR-2375, D-76, #145)
    // reason: in a worktree the landing's settings are main's (BR-2074) and this work's changed documents are counted, found as the landing finds them (BR-2375)
    const review = reviewSizeSettings(ws);
    if (review.review !== REVIEW_NONE) for (const h of reviewSizeHints(ws.root, read.corpus, review.budget, work)) console.error(h);
    process.exit(findings.length === 0 ? EXIT.ok : EXIT.refused);
  },
});

export const checkCommands: DomainCommands = { commands: [entry("check", 50, checkCmd)] };
