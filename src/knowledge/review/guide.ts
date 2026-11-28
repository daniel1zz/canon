import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const reviewGuide: readonly GuideLine[] = [
  { rank: 30, text: `Open review findings on a document you touch: tier each (A yours, B another session's advice, C the owner's) and close it at once, as canon guide findings says. A fix never drops, narrows or widens a goal the owner set: if it must, ask instead.` },
];

export const reviewTopics: readonly GuideTopic[] = [
  { name: "findings", when: `the rule review after a landing left blocking findings, or canon context or canon brief shows findings or notes on a document you touch`, text: `The rule review runs after landing; its blocking findings stay open on the documents they name. The commands: canon finding tier sets the tier; for a B finding, and for any spurious close, another session runs canon finding advise; a C finding is asked of the owner with canon finding ask; canon finding close closes it, with the arguments canon context shows.

Notes are not changes (canon context and canon brief show both): handle a note when you next change that document.` },
];
