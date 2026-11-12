import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const reviewGuide: readonly GuideLine[] = [
  { rank: 30, text: `The rule review runs after landing; blocking findings it verifies stay open on the documents they name: fix real ones at once in a change of their own. Notes are not changes: canon context and canon brief show both; handle a note when you next change that document.` },
];
