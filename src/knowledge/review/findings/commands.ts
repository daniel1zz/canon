import { defineCommand } from "citty";
import { entry, must, say, workspace, type DomainCommands } from "../../../invocation/command.ts";
import { closeFinding, renderClosed } from "./close.ts";
import { err } from "../../../kernel/result.ts";
import { advise, askOwner, callerOf, setTier } from "./tier.ts";
import { reconcileFindings, renderReconciled } from "./reconcile.ts";

/** `canon finding`: the main agent or a person settles an open review finding (BR-2453, D-99), as its tier allows (BR-2477, BR-2478, D-118). */
const finding = defineCommand({
  meta: { description: "Settle open review findings: close one as fixed by a commit on main, or as spurious with a quote from a document it names" },
  subCommands: {
    close: defineCommand({
      meta: { description: "Close one open review finding: --fixed <commit on main that changed a document it names> or --spurious \"<quote from one of them>\", with --reason" },
      args: {
        id: { type: "positional", required: true, description: "The finding's number (#n in canon context)" },
        fixed: { type: "string", description: "The commit on main, after the finding, that changed one of its documents" },
        spurious: { type: "string", description: "Text, at least 8 characters, found word for word in one of its documents on main" },
        reason: { type: "string", description: "What fixed it, or why it does not hold" },
        owner: { type: "string", description: "Tier C: the owner question that approves this close (canon finding ask), or an older one that decides it, with --covers" },
        covers: { type: "string", description: "With --owner naming a question not asked for this close: its words that decide it" },
      },
      run({ args }) {
        const ws = workspace();
        const c = must(
          closeFinding(ws.db, {
            cwd: ws.root,
            main: ws.config.main,
            actor: ws.actor,
            id: String(args.id),
            ...(typeof args.fixed === "string" ? { fixed: args.fixed } : {}),
            ...(typeof args.spurious === "string" ? { spurious: args.spurious } : {}),
            reason: typeof args.reason === "string" ? args.reason : "",
            caller: callerOf(process.env, ws.actor),
            ...(typeof args.owner === "string" ? { owner: args.owner } : {}),
            ...(typeof args.covers === "string" ? { covers: args.covers } : {}),
          }),
        );
        say(renderClosed(c));
      },
    }),
    tier: defineCommand({
      meta: { description: "Set who may settle a finding: A the session, B with another session's support, C the owner; a session only raises a tier" },
      args: {
        id: { type: "positional", required: true, description: "The finding's number" },
        tier: { type: "positional", required: true, description: "A, B or C" },
        reason: { type: "string", description: "Why it is this tier" },
      },
      run({ args }) {
        const ws = workspace();
        const r = must(setTier(ws.db, { actor: ws.actor, caller: callerOf(process.env, ws.actor), id: String(args.id), tier: String(args.tier), reason: typeof args.reason === "string" ? args.reason : "" }));
        say(`review finding #${r.id}: tier ${r.to}${r.from !== null && r.from !== r.to ? ` (was ${r.from})` : ""}`);
      },
    }),
    advise: defineCommand({
      meta: { description: "From another session: support or oppose closing a tier B finding one way (the fixing commit or the quote)" },
      args: {
        id: { type: "positional", required: true, description: "The finding's number" },
        support: { type: "boolean", description: "This close holds" },
        oppose: { type: "boolean", description: "This close does not hold" },
        fixed: { type: "string", description: "The fixing commit the close would name" },
        spurious: { type: "string", description: "The quote the close would give" },
        reason: { type: "string", description: "Why" },
      },
      run({ args }) {
        const ws = workspace();
        if (Boolean(args.support) === Boolean(args.oppose)) must(err("invalid", "give exactly one of --support and --oppose"));
        const r = must(
          advise(ws.db, {
            cwd: ws.root,
            actor: ws.actor,
            caller: callerOf(process.env, ws.actor),
            id: String(args.id),
            verdict: args.support ? "support" : "oppose",
            ...(typeof args.fixed === "string" ? { fixed: args.fixed } : {}),
            ...(typeof args.spurious === "string" ? { spurious: args.spurious } : {}),
            reason: typeof args.reason === "string" ? args.reason : "",
          }),
        );
        say(`review finding #${r.id}: ${args.support ? "supported" : "opposed"} closing it ${r.target.how === "fixed" ? `fixed by ${r.target.target.slice(0, 9)}` : "as spurious with that quote"}`);
      },
    }),
    ask: defineCommand({
      meta: { description: "Tier C: record the owner question that approves closing a finding one way; ask it in the conversation, then close with --owner" },
      args: {
        id: { type: "positional", required: true, description: "The finding's number" },
        fixed: { type: "string", description: "The fixing commit the close would name" },
        spurious: { type: "string", description: "The quote the close would give" },
        reason: { type: "string", description: "What this close does, for the owner to judge" },
      },
      run({ args }) {
        const ws = workspace();
        const r = must(
          askOwner(ws.db, {
            cwd: ws.root,
            actor: ws.actor,
            id: String(args.id),
            ...(typeof args.fixed === "string" ? { fixed: args.fixed } : {}),
            ...(typeof args.spurious === "string" ? { spurious: args.spurious } : {}),
            reason: typeof args.reason === "string" ? args.reason : "",
          }),
        );
        say(`question #${r.question} recorded; ask it word for word with the question tool, record the answer with canon human answer ${r.question}, then canon finding close with --owner ${r.question}:`);
        say(r.text);
      },
    }),
    reconcile: defineCommand({
      meta: { description: "Give two findings that pull the same documents opposite ways to the review for one wording that satisfies both; records an owner question when none exists" },
      args: {
        a: { type: "positional", required: true, description: "One finding's number" },
        b: { type: "positional", required: true, description: "The other finding's number" },
      },
      async run({ args }) {
        const ws = workspace();
        const r = must(await reconcileFindings(ws.db, { cwd: ws.root, main: ws.config.main, actor: ws.actor, a: String(args.a), b: String(args.b) }));
        say(renderReconciled(Number(String(args.a).replace(/^#/, "")), Number(String(args.b).replace(/^#/, "")), r));
      },
    }),
  },
});

export const findingCommands: DomainCommands = { commands: [entry("finding", 47, finding)] };
