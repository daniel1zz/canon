---
name: canon-rules
description: "Use when writing, editing, splitting or reviewing a canon rule (canon/rules/<domain>/BR-n.md), or turning a requirement, PRD or bug into rules before code. Triggers: 'write a rule', 'business rule', 'acceptance criteria', 'edge cases', 'what should happen when', '写规则', '业务规则', '验收标准', '边界情况', '需求拆解'. NOT for the architecture behind a rule (use canon-design) or for writing the test itself."
---

# Writing rules (canon)

A rule is what the product must do now, written so that any later session reads it one way, and so that a test can say pass or fail. It is the contract the implementer is held to: a vague rule is permission for the narrowest reading.

## 0. The main session writes the baseline

Only the top-level session responsible for the task writes baseline rule files: creating, editing (including titles, examples and front matter), retiring or moving them, including writing text already decided elsewhere. This keeps the product contract with the session that holds the owner's requirements, rather than letting implementation redefine its own acceptance criteria.

Subagents read the rules, implement and test them, and report gaps or contradictions with the rule ids, the concrete scenario and a suggested correction in their report. Test expectations follow canon-test. The main session resolves the requirement before dependent work continues; work independent of that choice can continue.

The main session is task-local, not one project-wide writer: concurrent top-level sessions stay within their assigned change and rule scope. For a rule edit discovered during delegated implementation, hand the change back through canon's existing claim workflow before the main session edits it.

## 1. Find the business, then the rule

A requirement lands in a business, not in a directory. Work down, in this order:

1. `canon context <domain|path>`. Read the domain README's `## 业务` list before any rule: it names the businesses this domain covers.
2. Pick the business the requirement belongs to, and read every rule marked with it. `canon rule new --domain <domain>` prints them grouped by business, the unassigned ones last. Those rules are the boundary of that business as it stands: your requirement either changes one of them, or draws a boundary none of them draws yet.
3. Then `canon search <word>` for the same behaviour elsewhere. A hit under another business or domain means either the boundary is in the wrong place, or the two have to name each other.
4. No business fits: write the new one into the domain README first, then point the rule at it. `canon check` refuses a rule this work added or changed that names a business its domain does not list.

Stop at step 2 if you cannot say which business the requirement belongs to. That is the signal to use canon-domains, not to write a rule and sort it out later.

- Most requirements change an existing rule; edit it in place, keep its id. A rule that is no longer true is retired (`canon rule retire`), never left beside its replacement.
- Choosing or creating the domain for a rule, or a domain that has grown mixed: use canon-domains.
- The same threshold stated in two rules will drift apart. Keep it in one and let the other rule name it.

## 1a. Resolve genuine conflicts by the latest effective requirement

First read both rules' scope, conditions and exceptions: different cases are not a conflict. If the same case requires incompatible outcomes, follow the latest effective requirement change. Establish that order from the recorded decisions, completed changes and the semantic diff in git history, not the largest rule id, file timestamps or the most recent edit to a file. A wording correction, title change, move or rebase does not make an older requirement newer; an unaccepted proposal or an unlanded draft does not override an effective requirement. If the effective order cannot be established, report the conflicting text and the missing evidence instead of guessing; resolve the open choice through section 5.

Record the winning requirement and its source in the change. Apply section 0 to correct the obsolete statements, use references for shared behaviour, retire a rule only when none of its requirements remain, and check the affected references and tests. This precedence resolves what to implement; it does not leave contradictory rules in place or bypass the project's checks.

## 2. Interrogate the requirement before writing

A PRD describes the happy path; the gaps are the work. For each requirement answer, in writing:

| Ask | Example answer that belongs in the rule |
|-----|------------------------------------------|
| What happens on failure? | command exits 1, nothing is written, the message names the file |
| What happens on the boundary value? | 30 days inclusive; the 31st day is refused |
| What happens on repeat? | the second run prints `no change` and writes nothing |
| What happens on concurrent use? | the second session gets exit 5 and the holder's change id |
| Who is refused, and what do they see? | a session without the claim: exit 5, `held by C-n` |
| What triggers it, observably? | `canon work land` run by a session; for an interactive product, which input (key, click, gamepad button) |

- State rounding and the side of every threshold explicitly ("at most 3", "more than 100 KB", "round down to the cent"). "Up to", "within", "about" are not sides.
- A guarantee about money or permission that rests only on a prompt or a warning is almost always one nobody built. Either the rule says what enforces it whichever way the user got there, or the point is not settled yet (section 5).

## 3. Observable behaviour only

Write what someone outside the code can observe: commands, flags, exit codes, printed messages, files and their content, events, HTTP responses. Do not name internal functions, classes, modules or variables: copied into a rule, the implementation's defects become the requirement, and the rule breaks at the first refactor.

Banned verbs (no observer, no observation): works, runs, handles, supports, integrates, wires, implements, 跑通, 实现, 集成, 支持, 可用, "handles errors gracefully". Replace each with **who does what, and what they observe**:

- Bad: `canon work land` 支持冲突处理.
- Good: `canon work land` 在 rebase 冲突时退出码 1，main 不动，提示列出冲突的文件。

## 4. One trigger, one outcome

- One rule = one trigger (a command, an event or a kind of input) and one outcome. Errors, exit codes and boundaries of the same trigger are examples of that rule, not separate rules.
- Split only for two different triggers, or two outcomes that can change independently (changing one would not force changing the other).
- A definition table (exit codes, a checklist) is one rule.

## 5. Undecided points

Never write a guess as if it were settled.

- The owner's: what the brief says to ask the human about, and product feel, meaning anything they would notice using the product (controls, look, wording, where the art or data comes from). `canon human ask "<question>"`.
- The agent's: anything else with real alternatives, such as internal structure or a library the owner would not notice. The main session settles choices that affect the baseline and records why with a decision (canon-design section 4), then writes the rule. A subagent hands such choices back (canon-parallel section 3).

## 5a. Before landing rules: list the open choices

The open choices otherwise surface mid-implementation, when the owner may not be there. Before landing a baseline, a release's rules or a change that adds rules, list them and settle each one (section 5 says whose it is):

- A rule whose outcome has no observable trigger (section 2): name the trigger.
- An "或", "or", "例如" or "e.g." in a release scope or a rule: pick one, or say in the text that the implementer chooses and why that is safe.
- A decision this change adds that is still `proposed`: accept it (`canon decision accept D-n`, after its challenge), or say in the change file why it stays proposed. `canon work land` prints a notice for each one.

## 6. The flow

1. After the search and reuse decision in section 1, run `canon rule new --domain <d> --title "<one-sentence outcome>"` only for behaviour that needs a new rule (allocates the id; the domain README says which code it governs).
2. Fill `## 规则`: the condition, then the required outcome. Chinese, like every document under `canon/`.
3. Fill `## 例子`: concrete inputs on **both sides** of each boundary, one line each, `input → observed result`. The happy path alone is not an example set.

   ```
   - 第 30 天申请退款 → 通过
   - 第 31 天申请退款 → 拒绝，退出码 1，提示“超过 30 天”
   - 同一笔退款再申请一次 → 提示已退款，不重复写入
   ```

4. A test named after the rule (the brief) that asserts what the rule says is observed.
5. The test goes in the same commit as the rule. A rule with no possible test (guaranteed by a vendor, say) is created with `--untested "<reason>"` instead.
6. A rule that names items of a list kept in code (check names, default values) points at the code instead of copying the whole list, and declares what it uses in front matter: `lists: [{ file: <path>, name: <constant>, items: [<each item the text names>] }]`. `canon check` then confirms on every landing that the text, the front matter and the code agree. Do not write a test that reads the rule file for this: a landing that changes only paths under `floor_skip_paths` skips the test suite, and `canon check` refuses a test that reads them.
7. `canon check` before landing; at land the rule review reads the rule against its whole domain and blocks contradictions.

## 7. Reachable from the real entry point

Component exists + tests green ≠ the user can reach it. The failure seen again and again: every unit test passes, and the command was never registered, the hook never called, the route never mounted.

- Every user-facing rule has at least one test that drives the behaviour from the real entry point: the CLI command as a user types it (for canon itself, `bun src/invocation/main.ts ...` in a throwaway repo), the HTTP route, the hook as the host invokes it. A test of the inner function proves the function, not the wiring.
- Purely internal behaviour with no entry point of its own is exempt, but then it is probably not a rule.

## Anti-patterns

- "Tests pass" as the rule. Tests are the oracle; the rule is what they assert.
