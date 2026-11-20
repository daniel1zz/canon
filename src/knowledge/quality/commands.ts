import { defineCommand } from "citty";
import { corpusOf, entry, fail, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import type { Quality } from "../documents/model.ts";
import { createDoc } from "../documents/write.ts";
import { refuseOnGuardedMain } from "../documents/guarded.ts";
import { recordVerdict, standingJson, standings, standingText, type Standing } from "./verdicts.ts";
import { aspectList, coverage, DECISION_LABEL, overviewQualityLine, qualitySummary, type AspectView } from "./aspects.ts";

/** `canon quality`: quality standards (Q-n) and the product's aspects (D-145, D-146). */

const JUDGES = ["test", "agent", "owner"];
const byNumber = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });
const UNCONFIRMED = "(负责人未确认)";

/** One aspect's line of `canon quality status` (BR-2557). */
function aspectLine(v: AspectView, stand: ReadonlyMap<string, Standing>): string {
  if (v.aspect.decision) return `${v.aspect.name}  ${DECISION_LABEL[v.aspect.decision.kind]}：${v.aspect.decision.reason}`;
  if (v.state === "uncovered") return `${v.aspect.name}  未覆盖`;
  return `${v.aspect.name}  ${v.standards.map((q) => `${q.id} ${q.status}${q.status === "draft" ? UNCONFIRMED : ""}${stand.has(q.id) ? ` ${standingText(stand.get(q.id)!)}` : ""}`).join(", ")}`;
}

/** Each standard in force's state, by id (BR-2589); a failure to read git is said loudly (exit 4), never shown as no state. */
function standMap(ws: ReturnType<typeof workspace>, corpus: Parameters<typeof standings>[1]): Map<string, Standing> {
  return new Map(must(standings(ws, corpus)).map((s) => [s.q.id, s]));
}

const quality = defineCommand({
  meta: { description: "Quality standards: how good the product must be, one threshold per aspect (canon/quality/Q-n.md), and the product's aspects (canon/quality/README.md)" },
  subCommands: {
    new: defineCommand({
      meta: { description: "Create a quality standard (allocates its id, status draft: in force, not yet confirmed by the owner; fill its 门槛 and 来源 afterwards)" },
      args: {
        title: { type: "string", required: true, description: "Title" },
        aspect: { type: "string", description: "The aspect it belongs to, as canon/quality/README.md lists it" },
        judge: { type: "string", description: "Who judges it: test, agent or owner" },
        covers: { type: "string", description: "Domains or repository paths it covers, comma-separated (. for the whole repository)" },
      },
      run({ args }) {
        const aspect = typeof args.aspect === "string" ? args.aspect.trim() : "";
        const judge = typeof args.judge === "string" ? args.judge.trim() : "";
        const covers = typeof args.covers === "string" ? args.covers.split(",").map((c) => c.trim()).filter((c) => c !== "") : [];
        // reason: checked before any id is allocated, so a usage error writes nothing (BR-2553)
        if (aspect === "") fail({ code: "invalid", message: "--aspect is required: the aspect this standard belongs to (BR-2553)" });
        if (!JUDGES.includes(judge)) fail({ code: "invalid", message: `--judge must be one of ${JUDGES.join(", ")} (BR-2553)` });
        if (covers.length === 0) fail({ code: "invalid", message: "--covers is required: the domains or repository paths this standard covers, comma-separated (BR-2553)" });
        const ws = workspace();
        refuseOnGuardedMain(ws, "quality", String(args.title));
        const { corpus } = corpusOf(ws);
        say(must(createDoc(ws.root, corpus, ws.db, ws.actor, { kind: "quality", title: String(args.title), quality: { aspect, judge, covers } }, ws.config.templates)));
        const list = aspectList(corpus);
        // reason: a reminder, never a refusal: the aspect can be listed after the standard is written (BR-2553, D-139)
        if (!list.aspects.some((a) => a.name === aspect)) console.error(`canon: aspect ${aspect} is not listed in ${list.path}: add \`- **${aspect}**\` under \`## 方面\` there, or canon check reports it (BR-2555)`);
      },
    }),
    verdict: defineCommand({
      meta: { description: "Record a verdict on a quality standard at a build commit: pass or fail, who judged, the evidence path; an event, no file. The owner's verdict (--by owner) cites an answered canon human question" },
      args: {
        id: { type: "positional", required: true, description: "The quality standard (Q-1)" },
        result: { type: "string", required: true, description: "pass or fail" },
        evidence: { type: "string", required: true, description: "Path of the recording, screenshot or report" },
        commit: { type: "string", description: "The build commit judged (default: the tip of main)" },
        by: { type: "string", description: "test, agent or owner (default: the standard's judge)" },
        question: { type: "string", description: "For --by owner: the number of the answered canon human question" },
      },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const question = args.question === undefined ? undefined : Number(args.question);
        // reason: a question number that is not a whole number is a usage error, not a missing question (BR-2587)
        if (question !== undefined && (!Number.isInteger(question) || question < 1)) fail({ code: "invalid", message: `--question must be a question number, got ${JSON.stringify(args.question)} (BR-2587)` });
        const out = must(recordVerdict(ws, corpus, {
          id: String(args.id).trim().toUpperCase(),
          result: String(args.result),
          evidence: String(args.evidence ?? ""),
          ...(typeof args.commit === "string" ? { commit: args.commit } : {}),
          ...(typeof args.by === "string" ? { by: args.by } : {}),
          ...(question !== undefined ? { question } : {}),
        }));
        say(out.line);
      },
    }),
    list: defineCommand({
      meta: { description: "List quality standards in force (draft and active; --all for retired ones too)" },
      args: { all: { type: "boolean", description: "Include retired standards" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const rows = corpus.docs.filter((d): d is Quality => d.kind === "quality" && (Boolean(args.all) || d.status !== "retired")).sort(byNumber);
        const stand = standMap(ws, corpus);
        if (args.json) return json(rows.map((q) => ({ id: q.id, status: q.status, title: q.title, aspect: q.aspect, judge: q.judge, covers: q.covers, confirmed: q.status === "active", verdict: stand.has(q.id) ? standingJson(stand.get(q.id)!) : null })));
        for (const q of rows) say(`${q.id.padEnd(8)} ${q.status.padEnd(8)} ${q.title}  方面 ${q.aspect}  判定 ${q.judge}${q.status === "draft" ? `  ${UNCONFIRMED}` : ""}${stand.has(q.id) ? `  ${standingText(stand.get(q.id)!)}` : ""}`);
        if (rows.length === 0) say("(no quality standards)");
      },
    }),
    status: defineCommand({
      meta: { description: "Each aspect of canon/quality/README.md with the standards covering it, the owner's decision (不适用 / 推迟), or 未覆盖" },
      args: { json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const { corpus } = corpusOf(ws);
        const c = coverage(corpus);
        const stand = standMap(ws, corpus);
        const summary = overviewQualityLine(qualitySummary(corpus));
        if (args.json) {
          return json({
            aspects: c.views.map((v) => ({ name: v.aspect.name, state: v.state, reason: v.aspect.decision?.reason ?? null, standards: v.standards.map((q) => ({ id: q.id, status: q.status, verdict: stand.has(q.id) ? standingJson(stand.get(q.id)!) : null })) })),
            unlisted: c.unlisted.map((q) => q.id),
            summary,
          });
        }
        if (c.views.length === 0) say(`(no aspects: ${c.list.path} lists none)`);
        for (const v of c.views) say(aspectLine(v, stand));
        if (c.unlisted.length > 0) say(`不在方面清单里：${c.unlisted.map((q) => `${q.id} (${q.aspect})`).join(", ")}`);
        say(summary);
      },
    }),
  },
});

export const qualityCommands: DomainCommands = { commands: [entry("quality", 107, quality)] };
