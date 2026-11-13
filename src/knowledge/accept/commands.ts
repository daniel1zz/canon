import { defineCommand } from "citty";
import { corpusOf, entry, EXIT, fail, must, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { accept } from "./accept.ts";

/** `canon accept`: the owner's acceptance of main's current commit (BR-2462, D-89, D-104). */
const acceptCmd = defineCommand({
  meta: { description: "Accept main's current commit: canon check clean, no open findings or suspect references, every landed review done, the commit tested; moves refs/canon/accepted" },
  async run() {
    const ws = workspace();
    const read = corpusOf(ws);
    const r = must(await accept(ws, say, read));
    if (r.verdicts.length > 0) {
      say("awaiting the owner's verdict:");
      for (const v of r.verdicts) say(`  #${v.finding} (question #${v.question}, canon human pending): ${v.text}`);
    }
    for (const reason of r.reasons) say(`not accepted: ${reason}`);
    for (const w of r.waiting) say(`not finished: ${w}`);
    if (r.reasons.length > 0) process.exit(EXIT.refused);
    if (r.waiting.length > 0) process.exit(EXIT.timeout);
    say(`accepted ${r.commit}`);
  },
});

export const acceptCommands: DomainCommands = { commands: [entry("accept", 46, acceptCmd)] };
