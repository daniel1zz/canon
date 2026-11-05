import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const issueGuide: readonly GuideLine[] = [
  { rank: 130, text: `A problem you will not fix now: open an issue, one root cause per issue, with a command that reproduces it, the expected result and the actual result.` },
];
