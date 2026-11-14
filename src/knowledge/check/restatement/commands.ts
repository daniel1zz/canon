import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, fail, json, say, workspace, type DomainCommands } from "../../../invocation/command.ts";
import { corpusRestatements, restatementLine, type Restatement } from "./restatement.ts";
import { HOOK_LIMIT, relatedTo, reasons, type Related } from "../../query/related.ts";
import { editedDoc, editedRestatements } from "./work.ts";

/** `canon restatements`: every restatement in the current rules and decisions (BR-2401); `--hook` is the edit hook (BR-2402). */

/** What the hook tells the session that just wrote the restating lines (BR-2402). */
export function hookContext(found: readonly Restatement[]): string {
  return [
    `canon: ${found.length} sentence(s) you just wrote restate another rule's behaviour instead of naming it. A copy goes stale when that rule changes, and the rule review after landing records one in added lines as a blocking finding when it disagrees with the rule it copies, else as a note (BR-2405).`,
    "Keep only what this document adds, and refer to the other rule for its behaviour (按 BR-x / 见 BR-x):",
    ...found.map((r) => `- ${restatementLine(r)}`),
  ].join("\n");
}

/** What the hook tells the session about the documents most related to the one it just wrote (BR-2421). */
export function relatedHookContext(id: string, related: readonly Related[]): string {
  return [
    `canon: the documents most related to ${id} (references both ways, shared text and names); check this edit does not contradict them:`,
    ...related.map((r) => `- ${r.doc.id} ${r.doc.title} (${reasons(r, id)})`),
  ].join("\n");
}

/** Claude Code's PostToolUse input: the edited file's path, or undefined when the input names none. */
function editedFile(): string | undefined {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { tool_input?: { file_path?: unknown } };
    const file = input.tool_input?.file_path;
    return typeof file === "string" && file !== "" ? file : undefined;
  } catch {
    return undefined;
  }
}

const restatements = defineCommand({
  meta: { description: "List the sentences in rules and decisions that restate another rule's behaviour instead of naming it; --hook checks the file a Write or Edit just changed and lists the documents most related to it" },
  args: {
    json: { type: "boolean" },
    hook: { type: "boolean", description: "Read Claude Code's PostToolUse input from stdin and check only the new lines of the edited rule or decision" },
  },
  run({ args }) {
    if (args.hook) {
      const file = editedFile();
      if (file === undefined) return;
      const edited = editedDoc(file);
      if (!edited.ok) fail(edited.error);
      if (edited.value === undefined || (edited.value.doc.kind !== "rule" && edited.value.doc.kind !== "decision")) return;
      const found = editedRestatements(edited.value);
      if (!found.ok) fail(found.error);
      const related = relatedTo(edited.value.corpus, edited.value.doc, HOOK_LIMIT);
      const parts = [...(found.value.length > 0 ? [hookContext(found.value)] : []), ...(related.length > 0 ? [relatedHookContext(edited.value.doc.id, related)] : [])];
      if (parts.length > 0) {
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n\n") } })}\n`);
      }
      return;
    }
    const ws = workspace();
    const found = corpusRestatements(ws.root, corpusOf(ws).corpus);
    if (args.json) json(found);
    else {
      for (const r of found) say(restatementLine(r));
      say(found.length === 0 ? "no restatements" : `${found.length} restatement(s) in ${new Set(found.map((r) => r.path)).size} document(s)`);
    }
    process.exit(EXIT.ok);
  },
});

export const restatementCommands: DomainCommands = { commands: [entry("restatements", 55, restatements)] };
