import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const verifyGuide: readonly GuideLine[] = [
  { rank: 70, text: `Before landing run canon work test, and canon work review once if rules or decisions changed: canon guide test.` },
];

export const verifyTopics: readonly GuideTopic[] = [
  { name: "test", when: `before landing, or when deciding which tests to run and whether to run the rule review`, text: `canon work test runs only the test files related to your change (changed tests, tests test_select_command picks, tests naming a rule you touched), one file per run, says why it picked each, runs the project's typecheck_command first and canon check last, and fails on either; --all runs every test file. The floor runs the full suite when landing.

canon work review is the post-land rule review on your current text, one model call: run it before landing, not after every small edit.` },
];
