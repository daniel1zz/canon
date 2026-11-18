import { defineCommand } from "citty";
import { AS_ARG, entry, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { delegate } from "./delegate.ts";
import { acceptDesign } from "./accept-design.ts";
import { designAnswer, needDesign } from "./requests.ts";
import { applyProposals, proposalNotice, proposeRule } from "./proposals.ts";
import { claimOfWorktree } from "../claims/claims.ts";

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
    const ws = workspace(args.as);
    // reason: the design owner sees the worker's proposed rule files in the request itself (BR-2524, #254)
    const r = must(needDesign(ws, change, `${String(args.request)}${proposalNotice(ws.root, change)}`));
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

/** `canon rule propose <BR-n>`: the rule as main has it, copied into this worktree's change for editing (BR-2524). */
export const proposeCmd = defineCommand({
  meta: { description: "Propose new text for a rule: copy it as main has it to canon/proposals/<C-n>/<BR-n>.md in this worktree's change and edit that copy (a worker cannot edit rule files)" },
  args: { id: { type: "positional", required: true, description: "The rule id (BR-n)" }, ...AS_ARG },
  run({ args }) {
    const ws = workspace(args.as);
    const claim = claimOfWorktree(ws.db, ws.root);
    if (!claim) fail({ code: "invalid", message: "canon rule propose runs in the worktree of a change you claim: its proposals travel with that change" });
    const p = must(proposeRule(ws, claim!.subject, String(args.id).toUpperCase()));
    say(`${p.path}: edit this copy of ${p.id}; the design owner applies it with canon rule apply ${claim!.subject}`);
  },
});

/** `canon rule apply <C-n> [BR-n ...]`: the design owner writes the change's proposals over the rules (BR-2524). */
export const applyCmd = defineCommand({
  meta: { description: "Design owner: write a change's proposed rule files (canon/proposals/<C-n>/) over the rules and delete them; all or none, refused when main changed a rule since it was proposed" },
  args: { change: { type: "positional", required: true }, ids: { type: "positional", required: false, description: "Only these rule ids (default: every proposal of the change)" } },
  run({ args, rawArgs }) {
    const ws = workspace();
    const change = String(args.change).toUpperCase();
    const only = rawArgs.filter((a) => !a.startsWith("-")).slice(1).map((a) => a.toUpperCase());
    for (const a of must(applyProposals(ws, change, only))) say(`${a.id} → ${a.rulePath}\n${a.diff.trimEnd()}`);
    say("commit the rule files with the change; the review and the evidence gate treat them as any rule edit");
  },
});

export const delegationCommands: DomainCommands = { commands: [entry("delegate", 12, delegateCmd, "work"), entry("accept-design", 13, acceptCmd, "work"), entry("need-design", 14, needDesignCmd, "work"), entry("design-answer", 15, designAnswerCmd, "work")] };
