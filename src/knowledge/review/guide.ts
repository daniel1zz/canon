import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const reviewGuide: readonly GuideLine[] = [
  { rank: 30, text: `Notes the rule review gives without blocking are not changes: never open a change for them. canon context and canon brief show the notes still open on a rule or decision; handle them when you next change that document. Blocks and real defects are fixed at once.` },
];
