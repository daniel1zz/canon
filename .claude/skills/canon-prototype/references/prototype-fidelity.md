# Prototype fidelity

When a decision keeps a prototype (HTML or a variant component, committed at the path the decision names) as the reference for a screen, the implementation matches it: no re-interpretation, no re-authoring of components that are already canonical.

The failure this prevents: the change file says "implement the Today page", the implementer writes markup from intuition, and the result matches the prototype at 60–70% (right colours, wrong spacing; right anchors, different markup; right layout, wrong breakpoints). The drift is found by a human, and the implementation cycle is redone.

## 1. Tasks cite the prototype by line range

Every UI task in the change file's 任务 cites the region it implements:

```
- [ ] 实现今日页的卡片列表（原型 docs/prototype/today.html#L120-L188）
```

A bare file path is not enough: prototype files are often hundreds of lines, and without the range the implementer scans and guesses.

## 2. Canonical components are copied verbatim

For any component whose markup is defined once in the project's design standards (a badge, message bubble, card, toggle, skeleton, wordmark, ...):

- read that canonical markup;
- copy it byte-identical, swapping only placeholder values;
- never re-author it from intuition.

"Better" markup written by an AI is not what was chosen. To improve a canonical component, change the canonical source and the decision, never silently in the implementation.

## 3. Checks for every UI task

Each is a runnable check with a threshold, written into the change file's 任务 or as a test named after the rule it proves:

| Check | How | Threshold |
|---|---|---|
| **Visual diff** | Screenshot the real route and compare with the prototype, using the project's browser test tooling (for example Playwright's screenshot comparison) | under 2% pixel difference, unless the decision sets another value per screen |
| **Token drift** | `grep -rnE '#[0-9a-fA-F]{3,8}\b' <impl files>`, minus the allowed token values | 0 off-palette values |
| **Accessibility** | axe (for example `@axe-core/playwright`) at the real route | 0 serious or critical violations |
| **Markup parity** | `grep -F "<canonical markup>" <impl file>` for each canonical component used | every one matches |

The visual diff runs last, after the screen is wired into its real route, so the screenshot shows what users will see. Tolerances drift upward over time: start at 2% and raise one only with the reason written in the decision.

## 4. Briefing a subagent for UI work

When another session or subagent implements the screen, the brief:

- embeds the canonical component markup verbatim, not a link to it;
- cites the prototype line ranges;
- lists the check commands and thresholds;
- forbids re-authoring documented components.

Without these the builder has no choice but to invent, and inventions drift.

| Rationalisation | Reality |
|---|---|
| "The prototype is just inspiration; I'll improve on it" | The chosen prototype is the specification. Improve it through the decision, not in the implementation |
| "A file path is enough" | Cite the range; long files make the implementer guess |
| "5% tolerance is fine" | Start at 2%; raise per screen only with a recorded reason |
