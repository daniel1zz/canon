import { defineCommand } from "citty";
import { entry, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { setPriority } from "./set.ts";
import { isTier } from "./store.ts";
import { TIERS } from "./tiers.ts";

/** `canon priority set`: a change's tier, P0 to P3 (BR-2602, D-155). */
const set = defineCommand({
  meta: {
    description:
      "Set a change's priority tier at once for every session: P0 must be done now (the owner only), P1 urgent, P2 normal (the default), P3 when there is room. The main session passes --reason and sets P1 to P3, never below a tier the owner set; the owner's tier is passed on with --relayed \"<their own words>\", only when the owner asked for it in the conversation. Workers cannot set a tier",
  },
  args: {
    change: { type: "positional", required: true, description: "The change (C-n)" },
    tier: { type: "positional", required: false, description: `${TIERS.join(", ")}; left out with --clear` },
    reason: { type: "string", description: "Why the main agent sets this tier (recorded)" },
    relayed: { type: "string", description: "The owner's own words this tier passes on (recorded, not checked)" },
    clear: { type: "boolean", description: "Back to the default P2" },
  },
  run({ args }) {
    const reason = typeof args.reason === "string" ? args.reason : undefined;
    const relayed = typeof args.relayed === "string" ? args.relayed : undefined;
    const given = [reason, relayed].filter((v) => v !== undefined);
    if (given.length !== 1 || given[0]!.trim() === "") fail({ code: "invalid", message: "give exactly one of --reason \"<why>\" (the main agent) or --relayed \"<the owner's own words>\", not blank" });
    const tier = typeof args.tier === "string" ? args.tier.toUpperCase() : undefined;
    if (args.clear && tier !== undefined) fail({ code: "invalid", message: "--clear takes no tier" });
    if (!args.clear && tier === undefined) fail({ code: "invalid", message: `name a tier (${TIERS.join(", ")}) or pass --clear` });
    if (tier !== undefined && !isTier(tier)) fail({ code: "invalid", message: `${args.tier} is not a tier: ${TIERS.join(", ")}` });
    const ws = workspace();
    const change = String(args.change).toUpperCase();
    say(must(setPriority(ws, { change, tier: tier as (typeof TIERS)[number] | undefined, by: relayed !== undefined ? "owner" : "main-agent", words: (relayed ?? reason)! })));
  },
});

export const priorityCommands: DomainCommands = {
  groups: [{ name: "priority", rank: 129, meta: { description: "Changes' priority tiers, P0 to P3: the order of starting, delegating and landing" } }],
  commands: [entry("set", 10, set, "priority")],
};
