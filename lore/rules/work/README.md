---
code:
  - src/work
  - src/coord
  - src/app
  - src/repo
---
# work

How sessions work at the same time without losing work: one change, one worktree, one claim; landings one at a time through the queue; main moves only by compare-and-swap after the floor and `lore check` pass on the exact tree.

## Terms

- **Claim**: a change's lease, held by one worktree.
- **Floor**: the project's command that must pass on the tree that becomes main (`lore/config.yaml`).
- **Landing**: rebase onto main, floor, check, review, move main.
- **Handoff**: the next step recorded when a session stops.
