---
name: canon-context-optimizer
description: "Use when shortening always-loaded or often-loaded instructions without losing a rule: CLAUDE.md, a skill, a rule-review or other agent prompt is too long, exceeds a token budget, or overflows the context. Triggers: 'compress prompts', 'reduce context size', 'optimize tokens', 'CLAUDE.md too long', '压缩上下文', 'CLAUDE.md 太长', '精简 prompt'."
---

# Context Optimizer (canon)

Shorten instructions that load into many sessions (in this project: `CLAUDE.md`, `skills/*/SKILL.md` and their references, the rule-review and code-review prompts in `src/knowledge/review/`) without losing a rule. Follow the steps in order.

## 1. Measure and snapshot first

- Measure the current size (lines, words or tokens) and report it. Never set a reduction target before measuring: a preset target forces rule cuts. The size is an outcome, not a goal.
- Keep the verbatim before-text where the next editor and the grader can read it. If the file is committed, the original is `git show HEAD:<file>`; record that commit in the change file. If it is not in git, or several files are merged, save it first in a note (`canon note new`).

## 2. Trace every sentence

Build a traceability table over every clause of the before-text. Each clause is exactly one of:

- **KEPT**: with the exact new phrase it became.
- **MERGED**: into which new line.
- **DROPPED**: as one of history, incident, dated measurement, mechanism walkthrough, duplicate-of `<where>`, common knowledge (something a strong model does by default).

Never drop an instruction, a condition or qualifier, a threshold, an ordering, an exit code, a command or a flag. Keep at most one short reason clause when it sets where or when the rule applies.

## 3. Check mechanically

Use a script, not a read-through:

- every KEPT phrase appears verbatim in the new text;
- every command, subcommand, flag, path and exit code present in the before-text is still present in the new text (extract them with a pattern from both, diff the sets, and account for every missing one in the table).

## 4. Grade the DROPPED list only

Use a grader that is a different run (preferably a different model) from the editor; the editor does not grade its own cuts. Give it only the DROPPED items with their surrounding before-text. Per item: reasoning first, then a binary verdict, instruction or explanation. Restore every item judged instruction.

## 5. Compare behaviour

For a file that steers many sessions (CLAUDE.md, a skill's main body, the rule-review prompt), run a fresh instance on a few representative tasks with the old text and with the new text, and compare what it does (commands run, steps skipped, answers given). A difference is a lost rule until shown otherwise.

## 6. Write it

- Use normal phrasing; do not add CRITICAL / MUST / ALL-CAPS emphasis and do not compress prose into arrows or symbol shorthand. A model follows plain sentences best.
- Measure the size last and report before and after, plus the traceability table's counts (kept / merged / dropped / restored).
- Land it as a normal change (`canon work land`). If the shortened file states product behaviour, the rules that describe it still have to agree.
