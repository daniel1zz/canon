import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const hooksGuide: readonly GuideLine[] = [
  { rank: 100, text: `After it lands, the project's post-land commands run in the background: canon work after-land --wait <C-n> (your change: another landing may come after yours) waits for them and the rule review, prints each exit code and their review lines; use it instead of reading or polling the log.` },
];
