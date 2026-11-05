import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, json, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { WORKFLOW_GUIDE } from "../../invocation/guide.ts";
import { backlogNotes, check, domainNameNotes, noteLine } from "./check.ts";
import { changeIdsOnBranches, listedBefore } from "../../work/session/inflight.ts";
import { budgetHint, sessionText, sizeLines } from "./session-text.ts";
import { testFilesFor } from "./tests.ts";

/** `canon check`: corpus integrity. */

const checkCmd = defineCommand({
  meta: { description: "Corpus integrity: files valid, ids unique, references resolve, rules and tests name each other" },
  args: { json: { type: "boolean" }, sizes: { type: "boolean", description: "Also write, on standard error, the bytes of text every session loads (BR-2256)" } },
  run({ args }) {
    const ws = workspace();
    const read = corpusOf(ws);
    const testFiles = testFilesFor(ws.root, ws.config);
    const input = { root: ws.root, ...read, testFiles, floorSkipPaths: ws.config.floorSkipPaths, branchChanges: must(changeIdsOnBranches(ws)), backlogBase: must(listedBefore(ws)) };
    const findings = check(input);
    // reason: a dangling id main already lists is said on stderr and never fails the check (BR-2150, #112)
    for (const n of backlogNotes(input)) console.error(noteLine(n));
    // reason: a domain named after a technical layer is a note too: renaming it is a judgement call, never a refusal (BR-2318)
    for (const n of domainNameNotes(input)) console.error(noteLine(n));
    if (args.json) json(findings);
    else for (const f of findings) say(`${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
    if (!args.json) say(findings.length === 0 ? `ok: ${read.corpus.docs.length} documents, ${read.corpus.domains.length} domains` : `${findings.length} finding(s)`);
    // reason: sizes and the budget hint go to standard error so stdout and the exit code stay as BR-2189 says (BR-2256, BR-2257)
    const parts = sessionText(ws.root, WORKFLOW_GUIDE);
    if (args.sizes) for (const line of sizeLines(parts, ws.config.sessionTextBudget)) console.error(line);
    const hint = budgetHint(parts, ws.config.sessionTextBudget);
    if (hint) console.error(hint);
    process.exit(findings.length === 0 ? EXIT.ok : EXIT.refused);
  },
});

export const checkCommands: DomainCommands = { commands: [entry("check", 50, checkCmd)] };
