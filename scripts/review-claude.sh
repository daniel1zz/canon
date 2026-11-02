#!/bin/sh
# Rule/decision reviewer for `canon work land` (config `review`): the prompt arrives on stdin,
# the verdict JSON must be printed on stdout. Uses the Claude Code CLI in print mode.
set -eu
exec claude -p --output-format text
