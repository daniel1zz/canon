---
name: canon-prototype
description: "Use when a question is cheaper to answer by building something throwaway than by arguing: sanity-checking a state machine or data model by driving it by hand, or comparing a few UI variants of a screen before committing. Triggers: 'prototype this', 'let me play with it', 'try a few designs', 'mock up', 'show me some options', '原型', '做个原型', '先做个样子看看', '出几个方案看看'. NOT for production UI implementation, architecture design (canon-design), or deciding what to build (canon-product)."
---

# Prototype (canon)

A prototype is **throwaway code that answers one question**. The question decides the shape; the answer is the only thing kept.

## 1. Pick the branch

- **"Does this logic / state model feel right?"** → `references/logic.md`: a tiny terminal app over a pure module, pushing the model through cases that are hard to reason about on paper.
- **"What should this look like?"** → `references/ui.md`: a few UI variants on a real page, switchable from a floating bar.

The two produce very different artifacts; picking wrong wastes the whole prototype. If the question is ambiguous, follow the surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

Before writing code, run `canon context <path>` for the code the prototype serves: its rules are constraints the prototype must respect (or deliberately test), and an accepted decision may already answer the question.

## 2. Rules for both branches

1. **Throwaway from day one, and marked as such.** Put it next to the module or page it is for, named so a casual reader sees `prototype`. Follow the project's existing routing and layout conventions; do not invent a new top-level structure.
2. **One command to run**, through the project's existing task runner (`bun run <name>`, `pnpm <name>`, a `Makefile` target). No new package manager or runtime.
3. **No persistence by default.** State lives in memory. If the question is about persistence, use a scratch database or file named `PROTOTYPE-wipe-me`.
4. **Skip the polish.** No tests, no error handling beyond what makes it run, no abstractions. Prototype code needs no rules or tests because it never lands on main.
5. **Surface the state.** After every action (logic) or variant switch (UI), show the full relevant state.
6. **It lives on the change branch only.** Commit it in the change's worktree; the branch plus `canon work stop --next "..."` carries it to the next session. Before `canon work land`, remove it or absorb the validated part properly (with rules and tests). The one exception: a chosen variant that the decision keeps as the implementation reference, committed as a static file at the path the decision names, outside the build.

## 3. UI variants: how different may they be

One rule, no exceptions without a human:

- **On an existing screen** (including a new section or card mounted inside one): every variant keeps the screen's layout, where its primary content lives, and its interaction patterns. Variants differ **only visually and in density**: spacing, type scale, emphasis, colour within the existing tokens, how much is shown at once, micro-interactions.
- **Structurally different variants** (different layout, information hierarchy, primary affordance, a new mechanism such as a toast stack or command palette) are allowed only **for a new screen**, or **when a human explicitly chose that**. Changing the structure of an existing screen is a direction question: `canon human ask "<现有 X 改成 Y？>" --option "保持现有结构,改成 Y"` before drawing it, one question per structural change.

Before drawing anything, inventory the existing UI: `references/design-system-inheritance.md`.

## 4. Who picks, and how it is recorded

The prototype's question states its judging criteria up front (task completion, density on a real data set, how the empty state reads). Then:

- **The pick is a decision** (canon-design section 4), titled `<界面> 采用变体 <X>`: 背景 is the question and criteria; 方案 lists the variants, each with a screenshot path or the switcher URL; 决定 names the winner and anything borrowed from others ("B 的标题栏 + C 的列表密度"); 后果 lists what changes in the real code.
- **A human picks** when the choice is direction: brand or visual identity, a structural variant, or a choice the humans reserved. Ask with `canon human ask`, citing the variants and your recommendation.
- **Logic prototypes**: the answer becomes rules (the behaviour the model must have, with the edge cases the session found as examples) and, if there were real alternatives, a decision. Surprises worth keeping but not yet decided go to a note (`canon note new`).

## 5. After the pick

- Delete the losing variants, the switcher, and the terminal shell.
- Fold the winner in **as real code**: rewritten with tests, its behaviour in rules, its tasks in the change file. Prototype code was written without tests or error handling; do not promote it as is.
- If the chosen variant is kept as the implementation reference (for example committed HTML at a path the decision names), implementation follows `references/prototype-fidelity.md`.
