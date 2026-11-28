import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const issueGuide: readonly GuideLine[] = [
  { rank: 130, text: `A problem you will not fix now: open an issue as canon guide issues says.` },
];

export const issueTopics: readonly GuideTopic[] = [
  { name: "issues", when: `before opening an issue for a problem you will not fix now, or when deciding whether to fix it on the spot`, text: `A simple problem found in this session is fixed on the spot, not reported, and recorded by the project's process; simple means at most 2 files change, an existing oracle proves it fixed, and no settled rule's behaviour changes.

A problem you will not fix now gets an issue, filed the way the project's CLAUDE.md says (gh issue create when it says nothing): one root cause per issue, reproducible and closable on its own, never bundled; with a command that reproduces it, the expected result and the actual result. Before filing, reproduce it for real and attach the command and its output, and search the project's issues for a duplicate. Then return to the original task. When work starts on it, open a work item by the project's process and name the issues it solves. Beyond the current scope, or truly blocking the original task: ask with the question tool.` },
];
