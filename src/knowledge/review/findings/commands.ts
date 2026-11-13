import { defineCommand } from "citty";
import { entry, must, say, workspace, type DomainCommands } from "../../../invocation/command.ts";
import { closeFinding, renderClosed } from "./close.ts";
import { reconcileFindings, renderReconciled } from "./reconcile.ts";

/** `canon finding close`: the main agent or a person settles an open review finding (BR-2453, D-99). */
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
          }),
        );
        say(renderClosed(c));
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
