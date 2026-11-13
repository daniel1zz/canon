import { effectiveAgentSession } from "../agent-session.ts";
import { agentSession, readRuntime } from "../../kernel/agent.ts";
import { codexHookStatus } from "../../install/codex.ts";
import { defineCommand } from "citty";
import { entry, fail, json, list, must, RUNTIME_ARG, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { findDoc } from "../../knowledge/query/query.ts";
import { claimOfWorktree } from "../claims/claims.ts";
import { changeOffMain, mainCorpus } from "../session/session.ts";
import type { Workspace } from "../workspace.ts";
import { hookStatus } from "../../install/hook.ts";
import { answer, answeredBy, ask, isFreeAnswer, parseAsked, questions, recordActor, recordAsked, refuseRecord, witnessMark } from "./questions.ts";

/**
 * The change `--change` names, as its id: a change on main or on its own change branch, matched in any case as
 * `canon work start` matches it. Not found when it is neither, so a question is never attached to nothing (BR-2075).
 */
export function namedChange(ws: Workspace, name: string): Result<string> {
  const onMain = mainCorpus(ws);
  if (!onMain.ok) return onMain;
  const doc = findDoc(onMain.value, name);
  if (doc?.kind === "change") return ok(doc.id);
  const off = changeOffMain(ws, name.toUpperCase());
  if (!off.ok) return off;
  if (off.value) return ok(off.value.doc.id);
  return err("not_found", `${name} is not a change on ${ws.config.main} or on a change/${name.toUpperCase()} branch; the question was not recorded`);
}

/** `canon human`: questions only a human can answer. */

const human = defineCommand({
  meta: { description: "Questions only a human can answer (direction and reserved decisions)" },
  subCommands: {
    ask: defineCommand({
      meta: { description: "Ask the human; work that does not depend on the answer continues" },
      args: { question: { type: "positional", required: true }, option: { type: "string", description: "Comma-separated options" }, multi: { type: "boolean", description: "The human may pick several of the options (needs --option)" }, change: { type: "string" } },
      run({ args }) {
        const ws = workspace();
        // reason: without --change the question goes to the change this worktree belongs to, even when its claim
        // expired: the worktree is still that change's (BR-2075)
        const subject = typeof args.change === "string" ? must(namedChange(ws, args.change)) : (claimOfWorktree(ws.db, ws.root)?.subject ?? null);
        const options = list(args.option);
        // reason: multi-select only means something for a question with options; usage error, nothing recorded (BR-2021, issue #130)
        if (args.multi && options.length === 0) fail({ code: "invalid", message: "--multi needs --option: only a question with options can be answered with several of them" });
        const id = ask(ws.db, ws.actor, subject, String(args.question), options, args.multi === true);
        say(`question #${id} recorded; \`canon human pending\` shows it${args.multi ? "; ask it with multiSelect: true in the question tool" : ""}`);
      },
    }),
    pending: defineCommand({
      meta: { description: "Questions waiting for an answer" },
      args: { all: { type: "boolean" }, json: { type: "boolean" } },
      run({ args }) {
        const ws = workspace();
        const qs = questions(ws.db, args.all ? "all" : "pending");
        if (args.json) return json(qs);
        for (const q of qs) say(`#${q.id} [${q.subject ?? "-"}] ${q.question}${q.options.length ? `  (${q.options.join(" | ")}${q.multi ? "; multi-select: ask with multiSelect: true" : ""})` : ""}${q.answer ? `\n    → ${q.answer} (${answeredBy(q)})${q.options.length && isFreeAnswer(q.options, q.answer) ? " [not one of the options]" : ""}${witnessMark(q)}` : ""}`);
        if (qs.length === 0) say("(nothing waiting)");
      },
    }),
    record: defineCommand({
      meta: { description: "Record what the human answered in the host's question tool (run by the PostToolUse hook, reads its data on stdin)" },
      args: { ...RUNTIME_ARG },
      async run({ args }) {
        const runtime = must(readRuntime(args.runtime));
        const parsed = parseAsked(await Bun.stdin.text(), runtime);
        const actor = must(recordActor(parsed.ok ? parsed.record.session : parsed.failure.session, process.env, runtime, parsed.ok ? parsed.record.agent_id : undefined));
        const ws = workspace();
        if (parsed.ok) return recordAsked(ws.db, actor, parsed.record);
        // reason: a failed record is kept with its session, so a later relay can say the record failed instead of "no record" (BR-2275, BR-2276, D-47)
        refuseRecord(ws.db, actor, parsed.failure);
        fail({ code: "invalid", message: parsed.failure.message });
      },
    }),
    answer: defineCommand({
      meta: { description: "Answer a question: a human at a terminal, or an agent passing on the human's own words with --relayed" },
      args: {
        id: { type: "positional", required: true },
        text: { type: "positional", required: true },
        relayed: { type: "string", description: "Agent only: the human's own words this answer passes on (recorded as a relay)" },
      },
      run({ args }) {
        const relayed = typeof args.relayed === "string" ? args.relayed : undefined;
        // reason: an id that is not a number is a usage error, not an unknown question: exit 2, nothing recorded (BR-2040, BR-2022)
        if (!/^\d+$/.test(String(args.id))) fail({ code: "invalid", message: `question id must be a number, as \`canon human pending\` shows it (#<n>); got ${String(args.id)}` });
        const ws = workspace();
        // reason: the terminal check runs inside answer(), so its refusal is recorded too (BR-2026, issue #57)
        // reason: the relaying session, not the actor, ties a relay to the question tool's record; the hook that writes
        // the record is looked for where Claude Code reads it, the primary checkout (BR-2276, D-47)
        const context = must(effectiveAgentSession(process.env, ws.root));
        const ctx = { session: context?.runtime === "codex" ? context.id : process.env["CLAUDE_CODE_SESSION_ID"]?.trim() || null, hookInstalled: () => { const h = agentSession()?.runtime === "codex" ? codexHookStatus(ws.primary) : hookStatus(ws.primary); return h.ok && h.value.record; } };
        must(answer(ws.db, Number(args.id), String(args.text), ws.actor, relayed, process.stdin.isTTY === true, ctx));
        say(`#${args.id} answered${relayed ? ` (relayed by ${ws.actor})` : ""}`);
      },
    }),
  },
});

export const humanCommands: DomainCommands = { commands: [entry("human", 130, human)] };
