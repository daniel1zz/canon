import type { GuideLine } from "../../cli/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/cli/guide.ts puts them in rank order. */
export const snapshotGuide: readonly GuideLine[] = [
  { rank: 125, text: `Uncommitted work is snapshotted before each Bash call; if a file's work is lost (a checkout, rm or overwrite), canon snapshot list shows where to get it back.` },
];
