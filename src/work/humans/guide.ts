import type { GuideLine } from "../../cli/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/cli/guide.ts puts them in rank order. */
export const humanGuide: readonly GuideLine[] = [
  { rank: 110, text: `Ask the human only about direction, choices left to them, spending money (paid APIs, cloud resources), irreversible actions on shared things (publishing, deleting remote data, pushing to someone else's repository), or credentials and second factors; do not wait for them on anything else. Ask in the conversation with the question tool (AskUserQuestion), copying question #n's text word for word as the question, then, in the same session, record their exact words, the option they picked or what they typed: canon human answer <n> <answer> --relayed "<their words>"; canon checks them against what the question tool recorded for that question. Never answer for them.` },
];
