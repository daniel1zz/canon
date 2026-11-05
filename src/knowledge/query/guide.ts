import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const queryGuide: readonly GuideLine[] = [
  { rank: 10, text: `Before changing code read the area: canon context <path|C-n|domain> lists its rules by title; read the ones you touch with canon show <id> (--full prints them all). Find anything: canon search <word|id>.` },
];
