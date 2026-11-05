import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const verifyGuide: readonly GuideLine[] = [
  { rank: 70, text: `Before landing run canon work test: it runs only the test files related to your change (changed tests, tests the project's test_select_command picks for your changed paths, tests that name a rule you touched), one file per run, and says why it picked each; it runs the project's typecheck_command first and canon check last, and fails on either; --all runs every test file. The floor runs the full suite when landing.` },
];
