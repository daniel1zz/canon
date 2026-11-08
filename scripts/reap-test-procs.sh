#!/bin/sh
# Finds the processes a test run left running and kills them (C-429). A test run is a directory
# canon-test.<runner pid>.<random> that scripts/test.sh makes as the tests' TMPDIR; the tests start their processes in
# temporary directories under it, and a child keeps its parent's cwd, so a process whose cwd is inside a run's directory
# belongs to that run. Detached processes (after-land hooks, review scripts, fixture loops) move to their own process
# group and to pid 1 when their parent exits, so neither the group nor the parent can find them: the cwd can.
#
#   reap-test-procs.sh --run <dir>    every process whose cwd is inside <dir>: named on stderr and killed.
#                                     scripts/test.sh runs it on its own directory when bun test has ended.
#   reap-test-procs.sh [--kill]       for every canon-test.* directory under ${CANON_TEST_TMP_ROOT:-/tmp} whose runner
#                                     is gone, the processes still inside it: listed, and killed only with --kill
#                                     (a shell someone opened there by hand would match too).
#
# Exit: 0 nothing found · 1 processes found (and killed when killing) · 2 usage · 4 no way to read a process's cwd.
set -eu

# reason: a process's group is not killed, only the processes found: a child a test started without `detached` shares
# the group of bun, scripts/test.sh and the terminal that started them (C-429)

usage() {
  echo "usage: reap-test-procs.sh --run <dir> | reap-test-procs.sh [--kill]" >&2
  exit 2
}

# how to read a process's cwd, decided once here: inside a pipeline an exit would not stop the script, and an empty
# listing would read as "nothing left behind"
if [ -r /proc/self/cwd ] && readlink /proc/self/cwd >/dev/null 2>&1; then
  method=proc
elif command -v lsof >/dev/null 2>&1; then
  method=lsof
else
  echo "reap-test-procs.sh: cannot read the working directory of processes: neither /proc nor lsof is available" >&2
  exit 4
fi

# pid and cwd of every process, one "pid<TAB>cwd" per line
cwds() {
  if [ $method = proc ]; then
    for p in /proc/[0-9]*; do
      c=$(readlink "$p/cwd" 2>/dev/null) || continue
      printf '%s\t%s\n' "${p#/proc/}" "$c"
    done
  else
    # lsof exits 1 when it cannot read some processes (other users'); what it could read is still printed
    lsof -d cwd -Fpn 2>/dev/null | awk '/^p/ { pid = substr($0, 2) } /^n/ { print pid "\t" substr($0, 2) }' || true
  fi
}

# pids whose cwd is <dir> or inside it, except this script and the one that started it
inside() {
  real=$(cd "$1" 2>/dev/null && pwd -P) || return 0
  cwds | awk -F '\t' -v d="$real" -v me="$$" -v parent="$PPID" \
    '$1 != me && $1 != parent && ($2 == d || index($2, d "/") == 1) { print $1 }'
}

describe() {
  ps -o pid=,command= -p "$1" 2>/dev/null | cut -c1-300 || true
}

# report <dir> <kill: yes|no> <what>: prints and optionally kills what is inside <dir>; returns 1 when anything was
report() {
  pids=$(inside "$1")
  [ -n "$pids" ] || return 0
  n=$(printf '%s\n' "$pids" | wc -l | tr -d ' ')
  echo "$3: $n process(es) still running with their working directory in $1$([ "$2" = yes ] && echo ', killed'):" >&2
  for p in $pids; do
    line=$(describe "$p")
    [ -n "$line" ] && echo "  $line" >&2
  done
  if [ "$2" = yes ]; then
    for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
  fi
  return 1
}

case ${1:-} in
--run)
  [ $# -eq 2 ] || usage
  report "$2" yes "test run left processes behind: a test did not end what it started (register it with processReaper() or hang() from src/work/testkit.ts)"
  ;;
--kill | '')
  [ $# -le 1 ] || usage
  kill=no
  [ "${1:-}" = --kill ] && kill=yes
  root=${CANON_TEST_TMP_ROOT:-/tmp}
  found=0
  for dir in "$root"/canon-test.*; do
    [ -d "$dir" ] || continue
    pid=${dir##*/canon-test.}
    pid=${pid%%.*}
    case $pid in '' | *[!0-9]*) continue ;; esac
    # reason: a run whose runner is alive may still need its processes; a reused runner pid only means nothing is reaped
    kill -0 "$pid" 2>/dev/null && continue
    report "$dir" "$kill" "left by a test run that has ended" || found=1
  done
  [ $found -eq 0 ] || { [ $kill = yes ] || echo "run again with --kill to kill them" >&2; exit 1; }
  ;;
*) usage ;;
esac
