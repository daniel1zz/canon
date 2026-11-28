import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const humanGuide: readonly GuideLine[] = [
  { rank: 110, text: `Ask the human only about direction, choices left to them, spending money (paid APIs, cloud resources), irreversible actions on shared things (publishing, deleting remote data, pushing to someone else's repository), or credentials and second factors; wait for them on nothing else. Ask with the question tool and record their answer as canon guide human says. Never answer for them.` },
];

export const humanTopics: readonly GuideTopic[] = [
  { name: "human", when: `asking the human a question and recording their answer`, text: `Ask with the question tool (AskUserQuestion in Claude Code, request_user_input in Codex, or the client's own), using question #n's text word for word as the question. Then, in the same session, record their exact words (the option picked or what they typed): canon human answer <n> <answer> --relayed "<their words>"; canon checks them against what the question tool recorded. Never answer for them.` },
];
