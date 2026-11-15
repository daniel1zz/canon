#!/bin/sh
# canon's rule review command (canon/config.yaml `review`) and the code review's AI command (CANON_CODE_REVIEW_AI):
# reads the prompt on stdin and prints the reviewer's answer on stdout. It calls the OpenAI chat completions API
# directly through scripts/review_openai.py, as zhushenkongjian's tools/review.sh does (owner, 2026-11-15: the Codex
# CLI's relay refused gpt-6.1-terra while the API answered).
# The endpoint, key and model come from .claude/review.local.json in the primary checkout (git-ignored; REVIEW_CONFIG
# overrides the path): {"base_url": "...", "api_key": "...", "model": "gpt-6.1-terra", "effort": "medium"}.
# A missing or incomplete file exits 2: there is no fallback to another model. The script starts python from an empty
# environment, so nothing of the session (hooks, MCP servers, other keys) reaches the reviewer.
set -eu

config="${REVIEW_CONFIG:-}"
if [ -z "$config" ]; then
	common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
		echo "review-api.sh: not inside canon's git repository; cannot find .claude/review.local.json" >&2
		exit 2
	}
	config="$(dirname "$common")/.claude/review.local.json"
fi

settings=$(python3 -I - "$config" <<'PY'
import json, sys
path = sys.argv[1]
try:
    cfg = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError) as e:
    sys.exit(f"review-api.sh: cannot read {path}: {e}")
missing = [k for k in ("base_url", "api_key", "model") if not (isinstance(cfg, dict) and cfg.get(k))]
if missing:
    sys.exit(f"review-api.sh: {path} has no {', '.join(missing)}")
print(cfg["base_url"]); print(cfg["api_key"]); print(cfg["model"]); print(cfg.get("effort") or "")
PY
) || exit 2

base_url=$(printf '%s\n' "$settings" | sed -n 1p)
api_key=$(printf '%s\n' "$settings" | sed -n 2p)
model=$(printf '%s\n' "$settings" | sed -n 3p)
effort=$(printf '%s\n' "$settings" | sed -n 4p)

exec env -i HOME="${HOME:-/tmp}" PATH="${PATH:-/usr/bin:/bin}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
	REVIEW_BASE_URL="$base_url" REVIEW_API_KEY="$api_key" REVIEW_MODEL="$model" REVIEW_EFFORT="$effort" \
	python3 -I "$(dirname "$0")/review_openai.py"
