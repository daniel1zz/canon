import { defineCommand } from "citty";
import { AS_ARG, entry, EXIT, fail, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { previewReview } from "./preview.ts";
import { requeueLandedReview, runLandedReviews } from "./landed-queue.ts";

/** `canon work review`: the rule review that runs after landing, on this worktree's current text (BR-2358). */

const review = defineCommand({
  meta: { description: "Run the rule review that runs after landing on this worktree's current text with main's reviewer (one model call; for a change to rules or decisions, once before landing)" },
  args: { ...AS_ARG },
  async run({ args }) {
    const out = await previewReview(workspace(args.as), WORKFLOW_GUIDE);
    const behind = (n: number, main: string) => {
      if (n > 0) say(`note: ${main.slice(0, 9)} has ${n} commit(s) after this branch's merge base; the landing's review reads the text after a rebase and may differ: run git rebase main first for a closer answer`);
    };
    switch (out.kind) {
      case "usage":
        console.error(`canon: ${out.message}`);
        process.exit(EXIT.usage);
      case "failed":
        console.error(`canon: ${out.message}`);
        process.exit(EXIT.env);
      case "unconfigured":
        console.error(`canon: review: not configured: ${out.needs.join(", ")} need a review and canon/config.yaml on main sets no \`review\`; set \`review\` (or \`review: none\` to turn it off) in a change of its own first`);
        process.exit(EXIT.usage);
      case "nothing":
        say("review: no changes to rules, decisions or standing instructions; nothing to review");
        behind(out.behind, out.main);
        return;
      case "off":
        say("review: none: canon/config.yaml on main is set not to review; nothing was run");
        // reason: with nobody to judge them, the landing refuses the wording-only records (BR-2239); said now, not after the queue turn (BR-2358)
        for (const id of out.wording) say(`wording judgement: ${id}: no review command to judge it; the landing would refuse it as a wording-only edit: change a line in a running test whose title names ${id}, or for a rule with untested:, a line under ## 验收`);
        for (const line of out.related) say(line);
        behind(out.behind, out.main);
        return;
      case "ok":
      case "block":
        say(`review: ${out.reviewed.join(", ")}`);
        if (out.reusedFrom !== undefined) say(`review: reused the passing preview of the same prompts (event ${out.reusedFrom}); the review command was not run for the rule review`);
        for (const f of out.findings) say(`${out.kind === "block" ? "review finding" : "review note"} (${f.review}): ${f.text}`);
        say(out.kind === "block" ? "review: block; the review after landing would record these findings as open findings once the verifier confirms them" : "review: ok");
        // reason: the landing asks the same question after its queue turn; asked here, a "behaviour" answer is known before landing (BR-2358, BR-2239, #166)
        for (const w of out.wording) {
          if (w.answer === "wording") say(`wording judgement: ${w.id}: wording; the landing records it as a wording-only edit and needs no new evidence for it`);
          else say(`wording judgement: ${w.id}: ${w.answer === undefined ? "no answer" : w.answer}; the landing would refuse it as a wording-only edit: change a line in a running test whose title names ${w.id}, or for a rule with untested:, a line under ## 验收`);
        }
        say("this was a preview: the review after landing runs again and its result is the one that counts");
        for (const line of out.related) say(line);
        behind(out.behind, out.main);
        if (out.kind === "block") process.exit(EXIT.refused);
    }
  },
});

/** `canon work review-landed`: the background reviewer of landed commits (BR-2441); each landing that needs it starts it. */
const reviewLanded = defineCommand({
  meta: { description: "Run the queued reviews of landed commits (the rule and duplicate reviews after a landing) one at a time until none is left; each landing that needs one starts it in the background, and canon work after-land reports the results. --again <C-n> queues the review after that change's latest landing again when it failed or was never queued" },
  args: { again: { type: "string", description: "Change id: queue the review after its latest landing again (only when that review failed or was never queued) and start the reviewer" } },
  async run({ args }) {
    if (args.again !== undefined) {
      const change = String(args.again).trim();
      if (!/^C-\d+$/.test(change)) {
        console.error(`canon: --again takes a change id (C-n), got ${JSON.stringify(args.again)}`);
        process.exit(EXIT.usage);
      }
      const q = requeueLandedReview(workspace(), say, change);
      if (!q.ok) fail(q.error);
      return;
    }
    const r = await runLandedReviews(workspace(), say, WORKFLOW_GUIDE);
    if (!r.ok) {
      console.error(`canon: ${r.error.message}`);
      process.exit(EXIT.env);
    }
  },
});

export const reviewCommands: DomainCommands = { commands: [entry("review", 35, review, "work"), entry("review-landed", 72, reviewLanded, "work")] };
