# Logic prototype

A tiny interactive terminal app that lets someone drive a state model by hand. Use it when the question is about **business logic, state transitions or data shape**: things that look reasonable on paper and only feel wrong once pushed through real cases ("does this machine handle X then Y?", "can this model represent the case where...?", "what should this API feel like?").

If the question is what something looks like, use `ui.md`.

## 1. State the question

One paragraph at the top of the file: which model, and which question. A prototype answering the wrong question is pure waste; writing it down lets the next session check.

## 2. Use the host project's language and tooling

No new runtime or package manager for a prototype. If the project has no obvious runtime, choose one and say why at the top of the file.

## 3. Keep the logic in a pure, portable module

The part that answers the question sits behind a small pure interface that could be lifted into the real code later. Pick the shape that fits the question, not the one easiest to wire to a terminal:

- **A pure reducer**, `(state, action) => state`: discrete events, a single state value.
- **A state machine** with explicit states and transitions: when "which actions are legal right now" is part of the question.
- **A few pure functions** over a plain data type: no implicit current state, just transformations.
- **A class or module with a clear method surface**: when the logic genuinely owns ongoing internal state.

Keep it pure: **no I/O, no terminal code, no `console.log` for control flow. The TUI imports it and calls into it; nothing flows the other direction.** That is what lets the validated module outlive the prototype; the shell is deleted.

## 4. The smallest TUI that shows the state

On every tick, clear the screen and re-render the whole frame (one stable view, not a growing scrollback). The frame fits on one screen and has two parts, in order:

1. **Current state**, one field per line or formatted JSON. Bold field names (`\x1b[1m`), dim less important context such as ids and derived values (`\x1b[2m`), reset with `\x1b[0m`. No styling library unless the project already has one.
2. **Keys**, at the bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`.

Loop: initialise one in-memory state object and render; read one key (or line); dispatch to a handler; re-render; until quit.

## 5. One command

Add a script to the existing task runner (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml`). With no task runner, put the command at the top of the file.

## 6. Drive it, then capture the answer

Push it through the hard cases yourself and hand over the run command. The interesting moments are "that should not be possible" and "I assumed X would be different": those are bugs in the *idea*, which is the point. Add actions as new cases come up.

The answer is recorded the canon way (`../SKILL.md` §4): behaviour into rules with the discovered edge cases as examples, real alternatives into a decision, open surprises into a note.

## Anti-patterns

- Tests on the prototype: a prototype that needs tests is no longer one.
- Wiring it to the real database: use memory unless persistence is the question.
- Generalising ("what if we later support X"): it answers one question.
- Blurring logic and TUI: a reducer that touches prompts or escape codes is no longer portable.
- Shipping the TUI shell: only the module behind it is worth keeping.
