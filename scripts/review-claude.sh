#!/bin/sh
# Rule/decision reviewer for `canon work land` (config `review`): the prompt arrives on stdin,
# the verdict JSON must be printed on stdout. Uses the Claude Code CLI in print mode.
# reason: each review prompt is new and never read again, so the 5-minute cache tier is cheaper than 1 hour (C-326).
# reason: with its default tools the model sometimes "reported" its findings through a tool and printed only a sentence, so the
# review failed with "printed no JSON"; the prompt holds everything the review reads, so it needs no tool.
set -eu
exec env FORCE_PROMPT_CACHING_5M=1 claude -p --model sonnet --tools "" --output-format text
