import { defineCommand } from "citty";
import { entry, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
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
  },
});

export const planCommands: DomainCommands = { commands: [entry("plan", 106, plan)] };
