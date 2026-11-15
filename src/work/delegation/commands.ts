import { defineCommand } from "citty";
import { AS_ARG, entry, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { delegate } from "./delegate.ts";
import { acceptDesign } from "./accept-design.ts";

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

export const delegationCommands: DomainCommands = { commands: [entry("delegate", 12, delegateCmd, "work"), entry("accept-design", 13, acceptCmd, "work")] };
