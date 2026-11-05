import { defineCommand } from "citty";
import { corpusOf, entry, fail, say, workspace, type DomainCommands } from "../../invocation/command.ts";
import { progressLines } from "./progress.ts";
import { executionStates } from "./state.ts";

/** `canon progress`: which rules are planned, passed, waiting for main's tests, or to be executed again (D-32). */

const progress = defineCommand({
  meta: { description: "Execution state of the rules (规划中 / 已通过 / 待 main 测试 / 待重新执行): per domain, or the ids for one domain or change" },
  args: { target: { type: "positional", required: false, description: "A domain (with its subdomains) or a change id (its rules:)" } },
  run({ args }) {
    const ws = workspace();
    const { corpus } = corpusOf(ws);
    const target = typeof args.target === "string" && args.target !== "" ? args.target : undefined;
    const lines = progressLines(corpus, executionStates(ws.root, corpus, ws.config.floorTiming), target);
    // reason: a target that is neither a domain nor a change is not found, and nothing goes to stdout (BR-2247, BR-2022)
    if (!lines) fail({ code: "not_found", message: `${target} is neither a domain nor a change` });
    for (const l of lines) say(l);
  },
});

export const executionCommands: DomainCommands = {
  commands: [entry("progress", 45, progress)],
};
