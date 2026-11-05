import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { executionStates } from "../../work/execution/state.ts";
import type { Release } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { createDoc } from "../documents/write.ts";
import { detailLines, releaseStatuses, statusJson, summaryLine } from "./status.ts";

/** `canon release`: a version's PRD document and what hangs on it (D-61). */

const byNumber = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });

const release = defineCommand({
  meta: { description: "Releases: a version's PRD (canon/releases/R-n.md); rules join one with `release: R-n` in their front matter" },
  subCommands: {
    new: defineCommand({
      meta: { description: "Create a release (allocates its id, status planned; edit the file afterwards)" },
      args: { title: { type: "string", required: true, description: "Title, e.g. the version name" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "release", title: String(args.title) }, ws.config.templates)));
      },
    }),
    list: defineCommand({
      meta: { description: "List releases that are not shipped (--all for shipped ones too)" },
      args: { all: { type: "boolean", description: "Include shipped releases" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const releases = corpusOf(ws).corpus.docs.filter((d): d is Release => d.kind === "release" && (Boolean(args.all) || d.status !== "shipped")).sort(byNumber);
        if (args.json) return json(releases.map(({ body: _b, ...r }) => r));
        for (const r of releases) say(`${r.id.padEnd(8)} ${r.status.padEnd(10)} ${r.title}`);
        if (releases.length === 0) say("(no releases)");
      },
    }),
    status: defineCommand({
      meta: { description: "Progress of releases: their tagged rules by execution state (规划中 / 已通过 / 待 main 测试 / 待重新执行), and for a shipped release the rules changed after it shipped; one line per release without an id" },
      args: { id: { type: "positional", required: false, description: "A release id (R-1): its rule ids by state" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const target = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim().toUpperCase() : undefined;
        // reason: an id that is no release is not found, and nothing goes to stdout (BR-2329, BR-2022)
        if (target !== undefined && findDoc(corpus, target)?.kind !== "release") fail({ code: "not_found", message: `${target} is not a release` });
        const all = releaseStatuses(corpus, executionStates(ws.root, corpus, ws.config.floorTiming));
        const one = target === undefined ? undefined : all.find((s) => s.release.id === target)!;
        if (args.json) return json(one ? statusJson(one, true) : all.map((s) => statusJson(s, false)));
        if (one) for (const l of detailLines(one)) say(l);
        else {
          for (const s of all) say(summaryLine(s));
          if (all.length === 0) say("(no releases)");
        }
      },
    }),
  },
});

export const releaseCommands: DomainCommands = { commands: [entry("release", 105, release)] };
