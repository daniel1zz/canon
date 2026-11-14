#!/bin/sh
# Rule/decision reviewer for `canon work land` (config `review`), also the duplicate and release reviews: the prompt arrives on
# stdin, the verdict JSON must be printed on stdout. Uses the Codex CLI with gpt-6.1-terra (the owner's choice, 2026-11-15).
# reason: the prompt holds everything the review reads, so it runs read-only and ephemeral, with the user's hooks and MCP servers
# off: a hook would register every review as a Concord agent and run canon brief, an MCP server only slows it down.
# reason: the review runs in a temporary worktree codex has not been told to trust, hence --skip-git-repo-check.
set -eu
exec codex exec --ephemeral --skip-git-repo-check --sandbox read-only -c features.hooks=false -c 'mcp_servers={}' -m gpt-6.1-terra -
