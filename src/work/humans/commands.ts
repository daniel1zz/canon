import { defineCommand } from "citty";
import { entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { claimOfWorktree } from "../claims/claims.ts";
import { answer, answeredBy, ask, questions } from "./questions.ts";

/** `canon human`: questions only a human can answer. */

const human = defineCommand({
  meta: { description: "Questions only a human can answer (direction and reserved decisions)" },
  subCommands: {
    ask: defineCommand({
      meta: { description: "Ask the human; work that does not depend on the answer continues" },
      args: { question: { type: "positional", required: true }, option: { type: "string", description: "Comma-separated options" }, change: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        const id = ask(ws.db, ws.actor, typeof args.change === "string" ? args.change : (claimOfWorktree(ws.db, ws.root)?.subject ?? null), String(args.question), list(args.option));
        say(`question #${id} recorded; \`canon human pending\` shows it`);
      },
    }),
    pending: defineCommand({
      meta: { description: "Questions waiting for an answer" },
      args: { all: { type: "boolean" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const qs = questions(ws.db, args.all ? "all" : "pending");
        if (args.json) return json(qs);
        for (const q of qs) say(`#${q.id} [${q.subject ?? "-"}] ${q.question}${q.options.length ? `  (${q.options.join(" | ")})` : ""}${q.answer ? `\n    → ${q.answer} (${answeredBy(q)})` : ""}`);
        if (qs.length === 0) say("(nothing waiting)");
      },
    }),
    answer: defineCommand({
      meta: { description: "Answer a question: a human at a terminal, or an agent passing on the human's own words with --relayed" },
      args: {
        id: { type: "positional", required: true },
        text: { type: "positional", required: true },
        relayed: { type: "string", description: "Agent only: the human's own words this answer passes on (recorded as a relay)" },
      },
      run({ args }) {
        const relayed = typeof args.relayed === "string" ? args.relayed : undefined;
        if (relayed === undefined && !process.stdin.isTTY) {
          fail({ code: "invalid", message: 'answer at a terminal, or as an agent relay the human\'s words with --relayed "<what they said>"' });
        }
        const ws = workspace();
        must(answer(ws.db, Number(args.id), String(args.text), ws.actor, relayed));
        say(`#${args.id} answered${relayed ? ` (relayed by ${ws.actor})` : ""}`);
      },
    }),
  },
});

export const humanCommands: DomainCommands = { commands: [entry("human", 130, human)] };
