import { releaseLineOf } from "../quality/related.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, fail, json, list, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { executionStates } from "../../work/execution/state.ts";
import type { Release } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { createDoc, setMeta } from "../documents/write.ts";
import type { Feature } from "../documents/model.ts";
import { releasesListing } from "./features.ts";
import { refuseOnGuardedMain } from "../documents/guarded.ts";
import { shipRelease } from "./ship.ts";
import { migrated, migrationSteps } from "./migrate.ts";
import { detailLines, featureStatuses, releaseStatuses, statusJson, summaryLine, type Workload } from "./status.ts";
import { changeGraph, graphInputs, memberOf, workload } from "../changes/graph.ts";
import type { Corpus } from "../documents/model.ts";
import { statedArgs, statedFor } from "../documents/stated.ts";

/** `canon release`: a version's PRD document and what hangs on it (D-61). */

const byNumber = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });

const release = defineCommand({
  meta: { description: "Releases: a version's PRD (canon/releases/R-n.md); rules join one with `release: R-n` in their front matter" },
  subCommands: {
    new: defineCommand({
      meta: { description: "Create a release (allocates its id, status planned; edit the file afterwards)" },
      args: { title: { type: "string", required: true, description: "Title, e.g. the version name" }, ...statedArgs("release") },
      run({ args }) {
        const ws = workspace();
        refuseOnGuardedMain(ws, "release", String(args.title));
        const { corpus } = corpusOf(ws);
        // reason: checked before an id is allocated (BR-2620)
        const fields = must(statedFor(corpus, "release", args as Record<string, unknown>));
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "release", title: String(args.title), fields }, ws.config.templates)));
      },
    }),
    list: defineCommand({
      meta: { description: "List releases that are neither shipped nor dropped (--all for those too)" },
      args: { all: { type: "boolean", description: "Include shipped and dropped releases" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const releases = corpusOf(ws).corpus.docs.filter((d): d is Release => d.kind === "release" && (Boolean(args.all) || (d.status !== "shipped" && d.status !== "dropped"))).sort(byNumber);
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
        // reason: the linked changes are workload beside the status, never part of done (BR-2328, BR-2568)
        const work = workloadOf(ws, corpus);
        if (args.json) return json(one ? statusJson(one, true, work(one.release)) : all.map((s) => statusJson(s, false, work(s.release))));
        if (one) {
          for (const l of detailLines(one, work(one.release))) say(l);
          // reason: the standards not proven are for the owner to weigh when saying yes, never a ship condition (BR-2593, D-145)
          const q = releaseLineOf(ws, corpus);
          if (q) say(q);
        } else {
          for (const s of all) say(summaryLine(s, work(s.release)));
          if (all.length === 0) say("(no releases)");
        }
      },
    }),
    start: defineCommand({
      meta: { description: "Mark a planned release in progress (status active); commit the file with your change" },
      args: { id: { type: "positional", required: true, description: "The release id (R-5)" } },
      run({ args }) {
        const ws = workspace();
        const r = releaseNamed(ws, String(args.id));
        refuseOnGuardedMain(ws, "release", r.title);
        if (r.status === "active") return say(`${r.id} is already active`);
        // reason: shipped and dropped are ends; only canon release ship and drop write them (BR-2508, BR-2332)
        if (r.status !== "planned") fail({ code: "refused", message: `${r.id} is ${r.status}; only a planned release is marked active` });
        must(setMeta(ws.root, r, { status: "active" }, r.status));
        say(`${r.id} → active (${r.path}; commit it with your change)`);
      },
    }),
    drop: defineCommand({
      meta: { description: "Drop a release that is not shipped (status dropped), with --into the release its work went to; landing it needs the owner's answer (owner_answers)" },
      args: { id: { type: "positional", required: true, description: "The release id (R-3)" }, into: { type: "string", description: "The release it went into (merged_into)" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const r = releaseNamed(ws, String(args.id));
        refuseOnGuardedMain(ws, "release", r.title);
        if (r.status === "dropped") return say(`${r.id} is already dropped`);
        if (r.status === "shipped") fail({ code: "refused", message: `${r.id} is shipped; a shipped release is not dropped (BR-2332)` });
        const into = typeof args.into === "string" ? args.into.trim().toUpperCase() : undefined;
        if (into !== undefined) {
          const target = corpus.docs.find((d): d is Release => d.kind === "release" && d.id === into);
          if (into === r.id || !target || target.status === "shipped" || target.status === "dropped") fail({ code: "refused", message: `--into ${into}: name another release that exists and is neither shipped nor dropped` });
        }
        must(setMeta(ws.root, r, { status: "dropped", ...(into !== undefined ? { merged_into: into } : {}) }, r.status));
        say(`${r.id} → dropped (${r.path}; commit it with your change)`);
      },
    }),
    "migrate-criteria": defineCommand({
      meta: { description: "Number the success criteria written the old way: list items in ## 成功标准 without an S<k> id get the next free one, or with --note move out of the list; prints what it would do unless --write" },
      args: {
        id: { type: "positional", required: false, description: "One release or feature (R-n, F-n); default every one in this checkout" },
        note: { type: "string", description: "Items to move out of the list instead, as printed: R-2#3,F-1#2" },
        write: { type: "boolean", description: "Write the files (commit them with your change)" },
      },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const target = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim().toUpperCase() : undefined;
        const goalDocs = corpus.docs.filter((d): d is Release | Feature => d.kind === "release" || d.kind === "feature");
        // reason: an id that is no release or feature is not found (BR-2567, BR-2022)
        if (target !== undefined && !goalDocs.some((d) => d.id === target)) fail({ code: "not_found", message: `${target} is not a release or feature` });
        const docs = goalDocs.filter((d) => target === undefined || d.id === target).sort((a, b) => (a.kind === b.kind ? byNumber(a, b) : a.kind === "release" ? -1 : 1));
        const notes = new Map<string, Set<number>>();
        for (const raw of list(args.note)) {
          const m = /^([A-Z]+-\d+)#(\d+)$/.exec(raw.toUpperCase());
          if (!m) fail({ code: "invalid", message: `--note ${raw}: name an item as printed, e.g. R-2#3` });
          notes.set(m[1]!, (notes.get(m[1]!) ?? new Set()).add(Number(m[2])));
        }
        const plans = docs.map((d) => {
          const text = readFileSync(join(ws.root, d.path), "utf8");
          return { d, text, steps: migrationSteps(text, notes.get(d.id) ?? new Set()) };
        });
        // reason: a note must name an unnumbered item of a document migrated here, or nothing is written at all (BR-2567)
        for (const [id, positions] of notes) {
          const plan = plans.find((p) => p.d.id === id);
          for (const n of positions) if (!plan?.steps.some((s) => s.item.position === n)) fail({ code: "invalid", message: `--note ${id}#${n}: not a list item without an id in ${id}'s ## 成功标准; nothing written` });
        }
        const todo = plans.filter((p) => p.steps.length > 0);
        if (todo.length === 0) return say("nothing to migrate");
        if (!args.write) {
          for (const p of todo) {
            say(`${p.d.id}: ${p.steps.length} list item(s) without an id`);
            for (const s of p.steps) say(`  ${p.d.id}#${s.item.position} → ${s.to}  ${s.item.first}`);
          }
          return say("nothing written: --write numbers them; --note <id>#<n>,… moves the named ones out of the list instead (BR-2504)");
        }
        refuseOnGuardedMain(ws, "release", todo[0]!.d.title);
        for (const p of todo) {
          writeFileSync(join(ws.root, p.d.path), migrated(p.text, p.steps));
          const numbered = p.steps.filter((s) => s.to !== "note").map((s) => s.to);
          const moved = p.steps.length - numbered.length;
          const parts = [numbered.length > 0 ? `numbered ${numbered.join(", ")}` : "", moved > 0 ? `moved ${moved} item(s) out of the list` : ""].filter(Boolean);
          say(`${p.d.id}: ${parts.join("; ")} (${p.d.path}; commit it with your change)`);
        }
      },
    }),
    ship: defineCommand({
      meta: { description: "Ship a release: needs every rule tagged with it passed and the owner's recorded yes (a canon human question naming `ship R-n`); lands status shipped and shipped_at as a change of its own, then tags release/R-n" },
      args: { id: { type: "positional", required: true, description: "The release id (R-1)" }, timeout: { type: "string", description: "Minutes to wait in the landing queue (default: land_timeout_minutes, 60)" } },
      async run({ args }) {
        const minutes = args.timeout === undefined ? undefined : Number(args.timeout);
        if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) fail({ code: "invalid", message: `--timeout must be a positive number of minutes, got ${JSON.stringify(args.timeout)}` });
        const ws = workspace();
        const out = must(await shipRelease(ws, String(args.id).trim().toUpperCase(), minutes === undefined ? ws.config.landTimeoutMs : minutes * 60_000, say));
        if (out.kind === "refused") fail({ code: out.code, message: out.message });
        if (out.kind === "not-landed") {
          console.error(`canon: shipping ${args.id} (${out.change}) did not land: ${out.message}`);
          // reason: still queued is a timeout, not a refusal: the caller runs the landing again (BR-2022)
          process.exit(out.timeout ? EXIT.timeout : EXIT.refused);
        }
        say(`shipped ${String(args.id).toUpperCase()} at ${out.shippedAt.slice(0, 9)} in ${out.change}, landed ${out.sha.slice(0, 9)}`);
        if (out.tag) say(`tag ${out.tag} -> ${out.shippedAt.slice(0, 9)}`);
        else console.error(`canon: warning: the tag release/${String(args.id).toUpperCase()} was not made (${out.tagProblem}); the record in the release document is landed and stands`);
      },
    }),
  },
});

/** The workload of each release or feature: its linked changes by graph state, read once (BR-2570, BR-2568). */
function workloadOf(ws: ReturnType<typeof workspace>, corpus: Corpus): (doc: Release | Feature) => Workload {
  const inputs = must(graphInputs(ws));
  return (doc) => workload(changeGraph(inputs, memberOf(corpus, doc)));
}

/** The release `raw` names, or exit 3 (BR-2508, BR-2511). */
function releaseNamed(ws: ReturnType<typeof workspace>, raw: string): Release {
  const id = raw.trim().toUpperCase();
  const doc = findDoc(corpusOf(ws).corpus, id);
  if (doc?.kind !== "release") fail({ code: "not_found", message: `${id} is not a release` });
  return doc;
}

const featureNamed = (ws: ReturnType<typeof workspace>, raw: string): Feature => {
  const id = raw.trim().toUpperCase();
  const doc = findDoc(corpusOf(ws).corpus, id);
  if (doc?.kind !== "feature") fail({ code: "not_found", message: `${id} is not a feature` });
  return doc;
};

/** `canon feature`: the features a release is made of (BR-2507, BR-2513, D-130). */
const feature = defineCommand({
  meta: { description: "Features: parts of a release with their own goal and success criteria (canon/features/F-n.md); a release lists its features in `features`, a rule joins one with `feature: F-n`" },
  subCommands: {
    new: defineCommand({
      meta: { description: "Create a feature (allocates its id, status active; edit the file afterwards)" },
      args: { title: { type: "string", required: true, description: "Title" }, ...statedArgs("feature") },
      run({ args }) {
        const ws = workspace();
        refuseOnGuardedMain(ws, "feature", String(args.title));
        const { corpus } = corpusOf(ws);
        // reason: checked before an id is allocated (BR-2620)
        const fields = must(statedFor(corpus, "feature", args as Record<string, unknown>));
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "feature", title: String(args.title), fields }, ws.config.templates)));
      },
    }),
    list: defineCommand({
      meta: { description: "List active features and the releases listing each (--all for dropped ones too)" },
      args: { all: { type: "boolean", description: "Include dropped features" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const rows = corpus.docs
          .filter((d): d is Feature => d.kind === "feature" && (Boolean(args.all) || d.status !== "dropped"))
          .sort(byNumber)
          .map((f) => ({ f, releases: releasesListing(corpus, f.id).map((r) => r.id) }));
        if (args.json) return json(rows.map(({ f, releases }) => ({ id: f.id, status: f.status, title: f.title, releases })));
        for (const { f, releases } of rows) say(`${f.id.padEnd(8)} ${f.status.padEnd(8)} ${f.title}  ${releases.length > 0 ? releases.join(", ") : "(no release)"}`);
        if (rows.length === 0) say("(no features)");
      },
    }),
    status: defineCommand({
      meta: { description: "Progress of features: their rules by execution state, their success criteria met, the workload of their linked changes, done or not (one line per active feature without an id)" },
      args: { id: { type: "positional", required: false, description: "A feature id (F-1): its rule ids by state and its criteria" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const target = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim().toUpperCase() : undefined;
        // reason: an id that is no feature is not found, and nothing goes to stdout (BR-2569, BR-2022)
        if (target !== undefined && findDoc(corpus, target)?.kind !== "feature") fail({ code: "not_found", message: `${target} is not a feature` });
        const all = featureStatuses(corpus, executionStates(ws.root, corpus, ws.config.floorTiming));
        const work = workloadOf(ws, corpus);
        const one = target === undefined ? undefined : all.find((s) => s.doc.id === target)!;
        const shown = all.filter((s) => s.doc.status !== "dropped");
        if (args.json) return json(one ? statusJson(one, true, work(one.doc)) : shown.map((s) => statusJson(s, false, work(s.doc))));
        if (one) for (const l of detailLines(one, work(one.doc))) say(l);
        else {
          for (const s of shown) say(summaryLine(s, work(s.doc)));
          if (shown.length === 0) say("(no features)");
        }
      },
    }),
    drop: defineCommand({
      meta: { description: "Drop a feature (status dropped); landing it needs the owner's answer (owner_answers)" },
      args: { id: { type: "positional", required: true, description: "The feature id (F-2)" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const f = featureNamed(ws, String(args.id));
        refuseOnGuardedMain(ws, "feature", f.title);
        if (f.status === "dropped") return say(`${f.id} is already dropped`);
        const shipped = releasesListing(corpus, f.id).filter((r) => r.status === "shipped");
        if (shipped.length > 0) fail({ code: "refused", message: `${f.id} is in ${shipped.map((r) => r.id).join(", ")}, shipped; a shipped release's feature is not dropped (BR-2515)` });
        must(setMeta(ws.root, f, { status: "dropped" }, f.status));
        say(`${f.id} → dropped (${f.path}; commit it with your change)`);
      },
    }),
  },
});

export const releaseCommands: DomainCommands = { commands: [entry("release", 105, release), entry("feature", 104, feature)] };
