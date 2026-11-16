import { defineCommand } from "citty";
import { AS_ARG, entry, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { delegate } from "./delegate.ts";
import { acceptDesign } from "./accept-design.ts";
import { designAnswer, needDesign } from "./requests.ts";

const delegateCmd = defineCommand({
  meta: { description: "Delegate a change with a published design contract" },
  args: { change: { type: "positional", required: true }, to: { type: "string", required: true }, contract: { type: "string", description: "Additional contract ids or paths, separated by commas" } },
  run({ args }) {
    const value: unknown = args.contract;
    const contracts = value === undefined ? [] : String(value).split(",").map((s) => s.trim());
    if (contracts.some((s) => s === "") || new Set(contracts).size !== contracts.length) fail({ code: "invalid", message: "--contract takes a comma-separated list with no empty or duplicate items" });
    must(delegate(workspace(), String(args.change).toUpperCase(), String(args.to), contracts, say));
  },
});

const acceptCmd = defineCommand({
  meta: { description: "Accept the latest delegated design and print what changed" },
  args: { change: { type: "positional", required: true }, ...AS_ARG },
  run({ args }) { must(acceptDesign(workspace(args.as), String(args.change).toUpperCase(), say)); },
});

const needDesignCmd = defineCommand({
  meta: { description: "Worker holding a delegated change: hand an undecided or contradictory design back to its design owner" },
  args: { change: { type: "positional", required: true }, request: { type: "positional", required: true, description: "What is undecided or contradictory, which rules or files it touches, which work stops because of it" }, ...AS_ARG },
  run({ args }) {
    const change = String(args.change).toUpperCase();
    const r = must(needDesign(workspace(args.as), change, String(args.request)));
    say(`${change}: design request #${r.id} pending; design owner ${r.owner}. Keep the claim and go on with work that does not depend on it; after the answer, canon brief shows it and canon work accept-design takes the new design.`);
  },
});

const designAnswerCmd = defineCommand({
  meta: { description: "Current design owner: answer a design request (#n); land any design change on main first, then answer, then delegate again" },
  args: { request: { type: "positional", required: true, description: "The request number n (#n)" }, answer: { type: "positional", required: true } },
  run({ args }) {
    const r = must(designAnswer(workspace(), String(args.request), String(args.answer)));
    say(`#${r.id} on ${r.subject} answered at main ${r.main}. If the answer changed the design, run canon work delegate ${r.subject} --to <worker> so the worker accepts the new design.`);
  },
});

export const delegationCommands: DomainCommands = { commands: [entry("delegate", 12, delegateCmd, "work"), entry("accept-design", 13, acceptCmd, "work"), entry("need-design", 14, needDesignCmd, "work"), entry("design-answer", 15, designAnswerCmd, "work")] };
