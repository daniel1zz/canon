import { defineCommand } from "citty";
import { corpusOf, entry, json, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import type { Release } from "../documents/model.ts";
import { createDoc } from "../documents/write.ts";

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
  },
});

export const releaseCommands: DomainCommands = { commands: [entry("release", 105, release)] };
