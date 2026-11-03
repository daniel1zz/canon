import type { GuideLine } from "../../cli/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/cli/guide.ts puts them in rank order. */
export const landGuide: readonly GuideLine[] = [
  { rank: 80, text: `Finish with canon work land --finish. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --next "<next step>".` },
  { rank: 90, text: `Landing can take minutes while it waits behind other landings: run it with a long timeout or in the background, and read its exit code directly, not through a pipe.` },
];
