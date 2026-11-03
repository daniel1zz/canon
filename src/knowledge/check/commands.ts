import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, json, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { check } from "./check.ts";
import { testFilesFor } from "./tests.ts";

/** `canon check`: corpus integrity. */

const checkCmd = defineCommand({
  meta: { description: "Corpus integrity: files valid, ids unique, references resolve, rules and tests name each other" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const ws = workspace();
    const read = corpusOf(ws);
    const findings = check({ root: ws.root, ...read, testFiles: testFilesFor(ws.root, ws.config) });
    if (args.json) json(findings);
    else for (const f of findings) say(`${f.rule.padEnd(18)} ${f.path}: ${f.message}`);
    if (!args.json) say(findings.length === 0 ? `ok: ${read.corpus.docs.length} documents, ${read.corpus.domains.length} domains` : `${findings.length} finding(s)`);
    process.exit(findings.length === 0 ? EXIT.ok : EXIT.refused);
  },
});

export const checkCommands: DomainCommands = { commands: [entry("check", 50, checkCmd)] };
