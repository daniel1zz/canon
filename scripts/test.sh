#!/bin/sh
# Runs `bun test` the way the floor and `canon work test` run it (C-247): one per-test timeout for every
# test file, and git reading only a fixed config written here, so this machine's git settings cannot change results.
# Arguments are passed on to `bun test` (e.g. one test file).
set -eu

# reason: bunfig.toml has no test timeout key, and setDefaultTimeout in a preload only covers the first file (C-247)
TIMEOUT_MS=30000

dir=$(mktemp -d "${TMPDIR:-/tmp}/canon-test-git.XXXXXX")
trap 'rm -rf "$dir"' EXIT
: > "$dir/empty"
cat > "$dir/gitconfig" <<EOF
[user]
	name = t
	email = t@t
[init]
	defaultBranch = main
[core]
	excludesFile = $dir/empty
	attributesFile = $dir/empty
EOF

# reason: Bun.spawn children get the environment bun started with, not later process.env edits,
# so the variables are set here, before bun starts (C-247)
# CANON_TEST_SCRIPT tells scripts/test-guard.ts (preloaded by bunfig.toml) that this script started bun test (C-271)
CANON_TEST_SCRIPT=1 GIT_CONFIG_GLOBAL="$dir/gitconfig" GIT_CONFIG_NOSYSTEM=1 bun test --timeout "$TIMEOUT_MS" "$@"
