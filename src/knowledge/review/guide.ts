import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const reviewGuide: readonly GuideLine[] = [
  { rank: 30, text: `The rule review runs after landing; its blocking findings stay open on the documents they name: settle each at once, a real one fixed then canon finding close <n> --fixed <commit> --reason \"<why>\", else --spurious \"<quote>\" --reason \"<why>\". Notes are not changes: canon context and canon brief show both; handle a note when you next change that document.` },
];
