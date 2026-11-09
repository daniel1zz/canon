import { defineCommand } from "citty";
import { AS_ARG, entry, EXIT, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { previewReview } from "./preview.ts";

/** `canon work review`: the landing's rule review on this worktree's current text (BR-2358). */

const review = defineCommand({
  meta: { description: "Run the landing's rule review on this worktree's current text with main's reviewer (one model call; for a change to rules or decisions, once before landing)" },
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
        for (const line of out.related) say(line);
        behind(out.behind, out.main);
        return;
      case "ok":
      case "block":
        say(`review: ${out.reviewed.join(", ")}`);
        if (out.reusedFrom !== undefined) say(`review: reused the passing preview of the same prompts (event ${out.reusedFrom}); the review command was not run for the rule review`);
        for (const f of out.findings) say(`${out.kind === "block" ? "review finding" : "review note"} (${f.review}): ${f.text}`);
        say(out.kind === "block" ? "review: block; the landing would refuse these changes" : "review: ok");
        // reason: the landing asks the same question after its queue turn; asked here, a "behaviour" answer is known before landing (BR-2358, BR-2239, #166)
        for (const w of out.wording) {
          if (w.answer === "wording") say(`wording judgement: ${w.id}: wording; the landing records it as a wording-only edit and needs no new evidence for it`);
          else say(`wording judgement: ${w.id}: ${w.answer === undefined ? "no answer" : w.answer}; the landing would refuse it as a wording-only edit: change a line in a running test whose title names ${w.id}, or for a rule with untested:, a line under ## 验收`);
        }
        say("this was a preview: the landing reviews again and its result is the one that counts");
        for (const line of out.related) say(line);
        behind(out.behind, out.main);
        if (out.kind === "block") process.exit(EXIT.refused);
    }
  },
});

export const reviewCommands: DomainCommands = { commands: [entry("review", 35, review, "work")] };
