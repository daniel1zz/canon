---
name: canon-rules
description: "Use when writing, editing, splitting or reviewing a canon rule (canon/rules/<domain>/BR-n.md), or turning a requirement, PRD or bug into rules before code. Triggers: 'write a rule', 'business rule', 'acceptance criteria', 'edge cases', 'what should happen when', '写规则', '业务规则', '验收标准', '边界情况', '需求拆解'. NOT for the architecture behind a rule (use canon-design) or for writing the test itself."
---

# Writing rules (canon)

A rule is what the product must do now, written so that any later session reads it one way, and so that a test can say pass or fail. It is the contract the implementer is held to: a vague rule is permission for the narrowest reading.

## 1. Find what exists

- `canon context <domain|path>` and `canon search <word>` first. Most requirements change an existing rule; edit it in place, keep its id. A rule that is no longer true is retired (`canon rule retire`), never left beside its replacement.
- Choosing or creating the domain for a rule, or a domain that has grown mixed: use canon-domains.
- The same threshold stated in two rules will drift apart. Keep it in one and let the other rule name it.

## 2. Interrogate the requirement before writing

A PRD describes the happy path; the gaps are the work. For each requirement answer, in writing:

| Ask | Example answer that belongs in the rule |
|-----|------------------------------------------|
| What happens on failure? | command exits 1, nothing is written, the message names the file |
| What happens on the boundary value? | 30 days inclusive; the 31st day is refused |
| What happens on repeat? | the second run prints `no change` and writes nothing |
| What happens on concurrent use? | the second session gets exit 5 and the holder's change id |
| Who is refused, and what do they see? | a session without the claim: exit 5, `held by C-n` |

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

- Direction, or a decision explicitly reserved for humans (spending money, irreversible on shared scope, needing a person's credentials): `canon human ask "<question>"` and keep working on what does not depend on the answer.
- Anything else with real alternatives: decide it yourself and record why with `canon decision new --title "..."` (背景, 方案 with every rejected option, 决定, 后果), then write the rule.

## 6. The flow

1. `canon rule new --domain <d> --title "<one-sentence outcome>"` (allocates the id; the domain README says which code it governs).
2. Fill `## 规则`: the condition, then the required outcome. Chinese, like every document under `canon/`.
3. Fill `## 例子`: concrete inputs on **both sides** of each boundary, one line each, `input → observed result`. The happy path alone is not an example set.

   ```
   - 第 30 天申请退款 → 通过
   - 第 31 天申请退款 → 拒绝，退出码 1，提示“超过 30 天”
   - 同一笔退款再申请一次 → 提示已退款，不重复写入
   ```

4. A test whose name starts with the rule id (`it("BR-n: ...")`) and asserts what the rule says is observed.
5. The rule, the test and the code go in the **same commit**. A rule with no possible test (guaranteed by a vendor, say) is created with `--untested "<reason>"` instead.
6. A rule that names items of a list kept in code (check names, default values) points at the code instead of copying the whole list, and declares what it uses in front matter: `lists: [{ file: <path>, name: <constant>, items: [<each item the text names>] }]`. `canon check` then confirms on every landing that the text, the front matter and the code agree. Do not write a test that reads the rule file for this: a landing that changes only paths under `floor_skip_paths` skips the test suite, and `canon check` refuses a test that reads them.
7. `canon check` before landing; at land the rule review reads the rule against its whole domain and blocks contradictions.

## 7. Reachable from the real entry point

Component exists + tests green ≠ the user can reach it. The failure seen again and again: every unit test passes, and the command was never registered, the hook never called, the route never mounted.

- Every user-facing rule has at least one test that drives the behaviour from the real entry point: the CLI command as a user types it (for canon itself, `bun src/invocation/main.ts ...` in a throwaway repo), the HTTP route, the hook as the host invokes it. A test of the inner function proves the function, not the wiring.
- Assert on the externally observable result (exit code, output, file content, row state), not on an internal return value.
- Purely internal behaviour with no entry point of its own is exempt, but then it is probably not a rule.

## Anti-patterns

- A rule naming a function, class or internal module. Rewrite it as the behaviour it implements.
- Examples that only show success, or a threshold with no example on each side.
- Two rules with the same threshold; a rule that restates another instead of naming it.
- A new rule created to "fix" an old one instead of editing the old one in place.
- "Tests pass" as the rule. Tests are the oracle; the rule is what they assert.
