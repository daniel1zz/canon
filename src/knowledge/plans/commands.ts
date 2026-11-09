import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { setMeta } from "../documents/write.ts";
import { findDoc } from "../query/query.ts";
import { planProblem } from "./link.ts";
import { listedChanges } from "../../work/session/inflight.ts";
import { mainCorpus } from "../../work/session/session.ts";
import { readPlan } from "./parse.ts";
import { detailLines, planStatuses, statusJson, summaryLine } from "./status.ts";

/** `canon plan`: how far the plans in change files are (D-77). */

const plan = defineCommand({
  meta: { description: "Plans: a change file's `## 计划` table of steps, done by changes that name them (`plan: C-n`, `steps: [..]`)" },
  subCommands: {
    status: defineCommand({
      meta: { description: "Progress of plans: steps done / working / ready / blocked with a percentage, one line per plan; with a plan's change id, its ready steps (dependencies landed) and what blocks the rest" },
      args: { id: { type: "positional", required: false, description: "The change id holding a plan (C-1): its steps by state" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const corpus = must(mainCorpus(ws));
        const target = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim().toUpperCase() : undefined;
        // reason: the plans are main's, the doers also include changes still on their own branch, so a step being worked on shows before its change lands (BR-2372)
        const { listed } = must(listedChanges(ws, corpus, [], () => true));
        const all = planStatuses(corpus, listed.map((l) => ({ change: l.change, onMain: l.onBranch.length === 0 })));
        const one = target === undefined ? undefined : all.find((p) => p.change.id === target);
        if (target !== undefined && one === undefined) {
          const doc = corpus.docs.find((d) => d.id === target);
          const why = doc?.kind !== "change" ? "is not a change" : readPlan(doc.body).kind === "invalid" ? "has a plan that `canon check` rejects" : "has no plan";
          fail({ code: "not_found", message: `${target} ${why}` });
        }
        if (args.json) return json(one ? statusJson(one, true) : all.map((p) => statusJson(p, false)));
        if (one) for (const l of detailLines(one)) say(l);
        else {
          for (const p of all) say(summaryLine(p));
          if (all.length === 0) say("(no plans)");
        }
      },
    }),
    link: defineCommand({
      meta: { description: "Name the plan and steps a change already started does: writes `plan` and `steps` into its file in this checkout (its worktree); commit it with the change" },
      args: {
        change: { type: "positional", required: true, description: "The change doing the steps (C-1)" },
        plan: { type: "string", required: true, description: "The change holding the plan (C-2)" },
        step: { type: "string", required: true, description: "The plan's step names this change does, comma separated" },
      },
      run({ args }) {
        const ws = workspace();
        const id = String(args.change).trim().toUpperCase();
        const planId = String(args.plan).trim().toUpperCase();
        const steps = list(args.step);
        if (planId === "" || steps.length === 0) fail({ code: "invalid", message: "--plan needs a change id and --step at least one step name" });
        // reason: the change file is edited where the change is worked on, like every document command, and lands with it (BR-2389)
        const doc = findDoc(corpusOf(ws).corpus, id);
        if (!doc || doc.kind !== "change") fail({ code: "not_found", message: `${id} is not a change in this checkout; run canon plan link in the change's worktree` });
        if (doc.status !== "open") fail({ code: "invalid", message: `${id} is ${doc.status}; only an open change is linked to a plan` });
        if (doc.plan !== undefined) fail({ code: "conflict", message: `${id} already does ${doc.plan} step(s) ${(doc.steps ?? []).join(", ")}; to change that, edit plan and steps in ${doc.path} by hand` });
        // reason: the same check as canon work start --plan --step, on main's plans (BR-2389, BR-2376)
        const bad = planProblem(must(mainCorpus(ws)), ws.config.main, { id: planId, steps });
        if (bad) fail({ code: "not_found", message: bad });
        must(setMeta(ws.root, doc, { plan: planId, steps }, "open"));
        ws.db.event(ws.actor, "plan.link", id, { plan: planId, steps });
        say(`${id} → plan ${planId} step${steps.length > 1 ? "s" : ""} ${steps.join(", ")} (${doc.path}; commit it with your change)`);
      },
    }),
  },
});

export const planCommands: DomainCommands = { commands: [entry("plan", 106, plan)] };
