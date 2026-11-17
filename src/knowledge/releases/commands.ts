import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { executionStates } from "../../work/execution/state.ts";
import type { Release } from "../documents/model.ts";
import { findDoc } from "../query/query.ts";
import { createDoc, setMeta } from "../documents/write.ts";
import type { Feature } from "../documents/model.ts";
import { releasesListing } from "./features.ts";
import { refuseOnGuardedMain } from "../documents/guarded.ts";
import { shipRelease } from "./ship.ts";
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
        refuseOnGuardedMain(ws, "release", String(args.title));
        const { corpus } = corpusOf(ws);
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "release", title: String(args.title) }, ws.config.templates)));
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
        if (args.json) return json(one ? statusJson(one, true) : all.map((s) => statusJson(s, false)));
        if (one) for (const l of detailLines(one)) say(l);
        else {
          for (const s of all) say(summaryLine(s));
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
      args: { title: { type: "string", required: true, description: "Title" } },
      run({ args }) {
        const ws = workspace();
        refuseOnGuardedMain(ws, "feature", String(args.title));
        const { corpus } = corpusOf(ws);
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "feature", title: String(args.title) }, ws.config.templates)));
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
