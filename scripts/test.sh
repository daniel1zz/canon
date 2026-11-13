#!/bin/sh
# Runs `bun test` the way the floor and `canon work test` run it (C-247): one per-test timeout for every
# test file, and git reading only a fixed config written here, so this machine's git settings cannot change results.
# Arguments are passed on to `bun test` (e.g. one test file, or --parallel=4 for the floor: half the cores, leaving the rest to sessions testing at the same time, C-290, C-301).
set -eu

# Tests supply their own host identity; the developer's Codex/Claude session must not leak into fixtures.
unset CANON_ACTOR CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_PID CODEX_SESSION_ID CODEX_THREAD_ID

# reason: bunfig.toml has no test timeout key, and setDefaultTimeout in a preload only covers the first file (C-247)
TIMEOUT_MS=30000

# reason: bun reads the listing of every directory above the cwd of each process it starts. Tests make a temporary
# directory per test, so this machine's shared TMPDIR held 534,000 leftovers, and every canon process a test started
# there took 1.7 s instead of 0.1 s: tests got slower run after run until the ones near 30 s timed out (C-376, #126).
# So the tests get a TMPDIR of their own, outside the shared one, that is removed when the run ends.
run_root=${CANON_TEST_TMP_ROOT:-/tmp}
reap="$(dirname "$0")/reap-test-procs.sh"
# a run killed with SIGKILL ran no trap: its directory (canon-test.<runner pid>.<random>) goes once that runner is gone,
# and so do the processes its tests left running in it (C-429)
for old in "$run_root"/canon-test.*; do
  # reason: only a real directory this user owns is a run; a symlink named like one (another user can make it in a
  # shared /tmp) would point the reaper at a directory that is not a test run and kill what runs there (#163)
  [ -d "$old" ] && [ ! -L "$old" ] && [ -O "$old" ] || continue
  pid=${old##*/canon-test.}
  pid=${pid%%.*}
  case $pid in '' | *[!0-9]*) continue ;; esac
  kill -0 "$pid" 2>/dev/null && continue
  sh "$reap" --run "$old" || true
  rm -rf "$old"
done
tmp=$(mktemp -d "$run_root/canon-test.$$.XXXXXX")
# reason: a run stopped by a signal reaps its processes too; the trap on EXIT alone does not run on every signal in sh
trap 'sh "$reap" --run "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
code=0
CANON_TEST_SCRIPT=1 GIT_CONFIG_GLOBAL="$dir/gitconfig" GIT_CONFIG_NOSYSTEM=1 bun test --timeout "$TIMEOUT_MS" "$@" || code=$?

# reason: a test that leaves a process running fails the run even when every test passed: the leftovers otherwise pile
# up run after run (#119, C-376), and only a failure stops the next test that forgets to end what it starts (C-429)
if ! sh "$reap" --run "$tmp"; then
  [ "$code" -ne 0 ] || code=1
fi
exit "$code"
