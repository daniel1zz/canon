import type { GuideLine } from "../../cli/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/cli/guide.ts puts them in rank order. */
export const verifyGuide: readonly GuideLine[] = [
  { rank: 70, text: `Before landing run canon work test: it runs only the test files related to your change (changed tests, tests that import changed files, tests that name a rule you touched), one file per run, and says why it picked each; --all runs every test file. The floor runs the full suite when landing.` },
];
