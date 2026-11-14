# Canon

Shared memory and coordination for a project built by many concurrent AI sessions.

Several AI coding sessions working on one repository at once lose track of each other: they forget why something was decided, overwrite each other's work and break `main`. Canon keeps the project's memory in the repository and coordinates the sessions, so that:

- **The current truth is in one place.** `canon/rules/` says how the product must behave, and whether each rule is planned, passed, or changed and waiting to be run again.
- **Every important decision says why.** `canon/decisions/` records the choice and the options that were rejected.
- **New sessions pick up where others stopped.** `canon brief` runs when a session starts and tells it how to work here and what is in flight.
- **Concurrent work stays safe.** Each work item has its own git worktree and claim. Business changes and document-free chores share the landing queue and checks, so work is not lost and no session overwrites another. With the default `floor_timing: before`, every commit on `main` passed the floor before it landed; with `floor_timing: after`, a commit can reach `main` before the floor tests it, and a failing floor is fixed forward by a `--fix-main` change. `refs/canon/accepted` always names a commit that was tested and accepted.
- **Documents do not lie.** `canon check` keeps documents and code consistent: no broken references, and every active rule is named by a test.
- **People only make the decisions left to them.** Direction and reserved questions go to `canon human`; nothing else waits for a person.

## Requirements

- [Bun](https://bun.sh) 1.3 or later (canon runs on bun)
- git
- Claude Code or Codex CLI with lifecycle hooks (validated with Codex CLI 0.167.2), for the skills and session hooks canon installs
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

`canon init` creates the `canon/` layout (`product.md`, `architecture.md`, `config.yaml`, rules, decisions, changes, notes). The default integration is Claude Code (`.claude/skills` and `.claude/settings.json`). For Codex, use:

```sh
canon init --agent codex --floor "bun run typecheck && bun test"
```

Codex gets skills in `.agents/skills`, hooks in `.codex/hooks.json`, and a small managed block in `AGENTS.md` (or an existing nonempty `AGENTS.override.md`). Your other instructions and settings stay intact. Review and trust the hooks with Codex's `/hooks` before expecting them to run. The session-start hook runs `canon brief`, which prints this workflow:

```sh
canon work start --title "what this change does"   # a new change in its own worktree
canon work test                                     # run the tests related to the change
canon work land --finish                            # land it on main through the queue
```

For non-business maintenance, use `canon chore start "update tools"`, then `canon chore land` in the printed worktree. Chores do not create a Change document or consume a C number. The other `canon work` commands apply to both kinds of work. `update`, `uninstall` and `release ship` create chores automatically.

Before first using chores, stop old landing processes and drain their queue; all participating sessions must use a version that understands chores. Finish or archive chores before downgrading.


Use `--agent all` to install both integrations. To add Codex to an existing project through a landed maintenance change, run `canon update --agent codex`. `canon install --agent codex` writes the assets into the current tree for you to commit. Later updates and uninstall follow the integrations Canon installed; an unrelated `.codex` directory does not opt a project in.

Codex sessions and child threads get separate `agent:codex-…` identities. A child uses its own `CODEX_THREAD_ID` for `--as`; the parent does not pass `--as`. Snapshots, claim checks, native `request_user_input` records and multi-file `apply_patch` checks use Codex's hook protocol. Third-party clients must expose compatible hooks and stable session IDs to get that automation; asynchronous question tools that only return a pending request are not answer evidence.

A newly initialized Codex-only project uses `codex exec --ephemeral --sandbox read-only -` as its reviewer. Existing `review` and lifecycle commands stay as configured, so a Codex developer can still use a Claude reviewer. The optional `canon usage` diagnostic continues to inspect Claude Code session logs; it does not report Codex usage.

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
