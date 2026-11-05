#!/bin/sh
# Runs `bun test` the way the floor and `canon work test` run it (C-247): one per-test timeout for every
# test file, and git reading only a fixed config written here, so this machine's git settings cannot change results.
# Arguments are passed on to `bun test` (e.g. one test file, or --parallel=4 for the floor: half the cores, leaving the rest to sessions testing at the same time, C-290, C-301).
set -eu

# reason: bunfig.toml has no test timeout key, and setDefaultTimeout in a preload only covers the first file (C-247)
TIMEOUT_MS=30000

# reason: bun reads the listing of every directory above the cwd of each process it starts. Tests make a temporary
# directory per test, so this machine's shared TMPDIR held 534,000 leftovers, and every canon process a test started
# there took 1.7 s instead of 0.1 s: tests got slower run after run until the ones near 30 s timed out (C-376, #126).
# So the tests get a TMPDIR of their own, outside the shared one, that is removed when the run ends.
run_root=${CANON_TEST_TMP_ROOT:-/tmp}
# a run killed with SIGKILL ran no trap: its directory (canon-test.<runner pid>.<random>) goes once that runner is gone
for old in "$run_root"/canon-test.*; do
  [ -d "$old" ] || continue
  pid=${old##*/canon-test.}
  pid=${pid%%.*}
  case $pid in '' | *[!0-9]*) continue ;; esac
  kill -0 "$pid" 2>/dev/null || rm -rf "$old"
done
tmp=$(mktemp -d "$run_root/canon-test.$$.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp"
dir="$tmp/git"
mkdir "$dir"
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
