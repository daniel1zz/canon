# Canon

Shared memory and coordination for a project built by many concurrent AI sessions.

Several Claude Code sessions working on one repository at once lose track of each other: they forget why something was decided, overwrite each other's work and break `main`. Canon keeps the project's memory in the repository and coordinates the sessions, so that:

- **The current truth is in one place.** `canon/rules/` says how the product must behave, and whether each rule is planned, passed, or changed and waiting to be run again.
- **Every important decision says why.** `canon/decisions/` records the choice and the options that were rejected.
- **New sessions pick up where others stopped.** `canon brief` runs when a session starts and tells it how to work here and what is in flight.
- **Concurrent work stays safe.** Each piece of work is a change in its own git worktree. Changes are claimed, landed through a queue and tested, so work is not lost and `main` is not broken.
- **Documents do not lie.** `canon check` keeps documents and code consistent: no broken references, and every active rule is named by a test.
- **People only make the decisions left to them.** Direction and reserved questions go to `canon human`; nothing else waits for a person.

## Requirements

- [Bun](https://bun.sh) 1.3 or later (canon runs on bun)
- git
- [Claude Code](https://claude.com/claude-code), for the skills and session hooks canon installs
- Optional: the GitHub CLI `gh`, for `canon issues`

## Install

```sh
npm install -g @danielzz/canon
```

## Quick start

In the repository you want to manage:

```sh
canon init --floor "bun run typecheck && bun test"   # the command that must pass before anything lands
git add -A && git commit -m "Add canon"
```

`canon init` creates the `canon/` layout (`product.md`, `architecture.md`, `config.yaml`, rules, decisions, changes, notes) and installs canon's skills and hooks into `.claude/`. From then on every Claude Code session started in the repository runs `canon brief` and follows the workflow it prints:

```sh
canon work start --title "what this change does"   # a new change in its own worktree
canon work test                                     # run the tests related to the change
canon work land --finish                            # land it on main through the queue
```

Fill in `canon/product.md` (what the product is for) and `canon/architecture.md` (its parts) first; every session reads them.

## Commands

| Command | What it does |
| --- | --- |
| `canon brief` | How to work here, and what is in flight |
| `canon search <word\|id>` | Search every document |
| `canon context <path\|domain\|C-n>` | Rules, decisions and open changes for an area |
| `canon show <id>` | Print a rule, decision, change or note |
| `canon rule new` / `canon decision new` | Write a new rule or decision |
| `canon work start\|test\|land\|stop` | One change, one worktree: start, test, land, or hand off |
| `canon check` | Check that documents and code agree |
| `canon human ask` | Record a question only a person can answer |
| `canon update` | Update canon's skills and hooks in the project |

Run `canon --help`, or `canon <command> --help`, for the full list.

## Exit codes

`0` success · `1` refused by a check · `2` usage error · `3` not found · `4` environment error (git, files, coordination database) · `5` conflict (claimed by someone else, already answered, already exists) · `70` a bug in canon · `75` not finished yet, run again later
