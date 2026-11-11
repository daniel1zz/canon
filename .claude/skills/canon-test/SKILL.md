---
name: canon-test
description: "Use when writing, adding or reviewing automated tests, building a feature or fixing a bug test-first, or asking whether a green suite actually proves anything. Triggers: 'write tests', 'add tests', 'test this', 'regression test', 'TDD', 'red-green', 'is this test any good', 'mock this', 'flaky test', '写测试', '补测试', '测试驱动', '这个测试靠谱吗'. NOT for accepting a finished feature end to end (use canon-uat) or for hunting down a known bug (use canon-diagnose)."
---

# Test (canon)

A test exists to find bugs. A suite that passes on broken code is worse than no suite, because people believe it. In canon a test proves a rule (section 4), and its cases come from the rule's `## 例子`.

## 1. Expectations before code

1. `canon context <path>` for the code under test: the domain's rules, accepted decisions and open changes. Find the rules this code implements (`canon search <term>` if unsure).
2. **Before opening the implementation**, write the expected behaviours as test skeletons, from the rule's `## 规则` and `## 例子` only:
   - every example becomes a case, input and expected result taken from the example, not from the code;
   - every refusal the rule implies becomes a case, checked as section 4 says.
   Reading the implementation first produces tests that mirror it, bugs included.
3. No rule covers the behaviour, or its examples do not reach the boundary: resolve the gap through canon-rules section 0. For conflicting rules use its section 1a before choosing expectations.
4. A test that fails because the code contradicts the rule has found a defect. Do not change the expected value to match the code. Fix the code. If the requirement itself needs to change, use canon-rules section 0 and record why in the change.

## 2. Read the implementation adversarially

Now read the code, hunting for places where it goes beyond or against the rule. For each hit, write a test asserting what the rule wants, not what the code does.

| Pattern | Signal (grep) | Test to write |
|---------|---------------|---------------|
| Silent fallback | `?? `, `\|\| `, `?? 0`, `?? []`, `?? {}` | Does the rule say fall back, or refuse? Assert the rule's answer. |
| Silent catch | `catch {`, `catch (e) { return`, empty catch | Make the dependency fail: is the error surfaced or swallowed? |
| Hardcoded value | magic numbers, string literals outside constants | Vary the input; if the output does not change, it is hardcoded. |
| Missing validation | parameters used without checks | Pass null, empty, out-of-range: validated, or does the rule allow it? |
| Type assertion | `as any`, `as unknown as`, `!` | Feed the case the assertion hides (the value really is null). |
| Early return | `if (x) return` with no else | Exercise the other path: intended, or a missing case? |

## 3. Vertical slices, one rule at a time

Do not write every test of the change first and then all the code. Tests written in bulk test imagined behaviour and lock in structure before you understand it.

```
RIGHT:  rule1 tests → impl1,  rule2 tests → impl2 ...
WRONG:  every test of the change,  then all the code
```

The unit of a cycle is one rule: its `## 例子` were written together, before any code, so writing their tests together adds nothing imagined. Each cycle: write the tests for every example of one rule (and the refusals it implies) → run them once and **check that each new test fails for the expected reason** (the assertion, not an import or load error; a test that passes already, or fails for another reason, is looked at before going on) → write the minimum code to pass → run them green → next rule. The next rule's tests respond to what this cycle taught you. One test per cycle is still right for a rule whose behaviour you do not understand yet. Refactor only when green, re-running after each step.

Testing code that already exists still needs the red: break the input or revert the fix and watch the test catch it.

## 4. What every test must satisfy

- **Proves a rule**, named as the brief says. A test that proves no rule usually means a rule is missing. An active rule nobody tests needs a test, or `untested: <reason>` in its front matter.
- **Public interface only.** It survives an internal rename; if a refactor breaks it while behaviour stays the same, it was testing implementation.
- **At least two input sets producing different outputs** on the happy path. This defeats an implementation that returns a constant.
- **Refusals are tested like successes**: exit code, error text, and absence of side effects.
- **Mocks are the exception.** Prefer the real thing: a temp directory, a throwaway git repo, an in-memory database. Mock only boundaries you do not own. Before adding a mock, answer: what bug does it hide, and does removing it change any outcome? If more than half a test is mock setup, it tests the mocks.
- **Every mock cites its source.** Read the real emit or return site and copy its shape, field for field: `// Verified against src/events.ts:42`. A mock built from the design rather than the code once let 65 tests pass on a broken feature (the real event had no `type` field).
- **Deterministic**: fixed clock, seeded randomness, an isolated temp dir per test, no network.
- **Schema changes on existing data** test both paths: newly written rows and rows that existed before the migration.

False-green patterns to scan for before committing, with grep commands: [references/false-green-patterns.md](references/false-green-patterns.md).

## 5. Verification discipline (all eight, every time)

1. **Enumerate mandated failures first.** Before running anything, list every case where the target must fail: invalid input → usage error, missing permission → denial, corrupt state → loud abort, check violation → refusal with a fix hint. Each gets exercised and compared with the rule (section 4). An unexercised mandated failure is an uncovered requirement.
2. **Prove the oracle can fail before trusting its pass.** New tests: section 3. Inherited suite: mutate one guarded behaviour and confirm the suite catches it. A suspiciously fast pass gets re-run before it is believed.
3. **Negative controls travel in pairs.** Every "X is now allowed / fixed" ships with "Y is still refused". Fixed a false denial? Prove the true denial still fires. Loosened a matcher? Prove the true positives still match.
4. **Hunt silent fallbacks on purpose.** Feed unknown flags, out-of-range config values, undeclared fields, unparseable files. If the answer to "what happens on bad input?" is "nothing visible", that is a finding (one real case: a TTL of `0` silently became 120).
5. **Boundaries are failure scenarios.** Zero, empty, duplicate, expired, concurrent, over limit, already deleted, already done. Exercise illegal state transitions, not only the happy walk.
6. **Measure without lying to yourself.** Read exit codes unpiped: `cmd > out.txt 2>&1; echo $?`, never `cmd | tail; echo $?` (that reports `tail`). Assert on actual bytes and state, not summaries. Reproduce any anomaly with clean measurement before reporting it.
7. **Name what you did not cover.** Every report or commit message lists the cases, surfaces and environments not exercised. A silent scope cap reads as full coverage.
8. **Verdicts come from external oracles**: exit codes, output, persisted state, an independent reviewer, never your own reading of your own work. Before reporting a finding that matters, try once to refute it.

## 6. Running tests in a worktree

Run tests the way the project runs them:

```
canon work test                  # each picked file through the project's test_command
sh scripts/test.sh src/a.test.ts # one file yourself, when test_command is "sh scripts/test.sh {file}"
bun test src/a.test.ts           # the same, when test_command is "bun test {file}"
```

Use the command `test_command` in `canon/config.yaml` names, not the bare test runner: a project may wrap the runner to set the test timeout or the environment, and a bare run then gives results the floor does not.

Many worktrees running full suites at once once drove load to 150 and produced 70+ phantom failures. A failure seen only under load is not evidence about your change; re-run that one test alone before acting on it.

## 7. Before committing

Go through sections 1, 4 and 5 once more against the diff: each is a check, not advice. The false-green scan is clean, and the uncovered list (section 5 item 7) is in the commit message.

A defect found but not fixed in this change becomes a GitHub issue (`gh issue create`), written as the brief says.
