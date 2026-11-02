# CLAUDE.md

Lore: shared memory and coordination for a project built by many concurrent AI sessions. Read `lore/product.md` once: the seven promises (P1-P7) are why everything here exists.

## Where things are

- `lore/rules/<domain>/BR-n.md` — what the product must do now, one rule per file. `lore/rules/<domain>/README.md` names the code each domain governs.
- `lore/decisions/D-n-*.md` — why. `lore/changes/C-n-*.md` — work. `lore/notes/` — research, retros.
- `src/` — the lore implementation. Its tests are named after the rules they prove (`it("BR-2014: ...")`).

## Working

```
lore context <path|C-n|domain>     # read this before changing code: the whole domain, current
lore search <words|id>
lore work start --title "<what>"   # new change → its own worktree; cd there
  ...edit code, rules, the change file; commit...
lore work land [--finish]          # queue → rebase → floor → lore check → rule review → main
lore work stop --next "<step>"     # when you stop before finishing
lore human ask "<question>"        # only for direction or a decision reserved for a human
```

- A behaviour change edits its rule file in the same commit as the code; a new rule: `lore rule new --domain <d> --title "..."`. Every active rule is named by a test, or carries `untested: <reason>`.
- A non-trivial choice with real alternatives gets a decision: `lore decision new --title "..."`.
- Ids written in backticks are examples, not references.
- Landing is the only gate. If it refuses, the message names what to fix; fix it and land again.
- A problem you do not fix now becomes a GitHub issue (`gh issue create`): one root cause, a command that reproduces it, expected vs actual.
- Exit codes: 0 ok · 1 refused by a check · 2 usage · 3 not found · 5 held or moved · 75 queue timeout.
