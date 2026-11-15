"""Send the review prompt on stdin to an OpenAI-format chat completions endpoint and print the reply.

scripts/review-api.sh runs this for canon's rule review and the code review after landing (owner, 2026-11-15:
call gpt-6.1-terra through the API as zhushenkongjian does, instead of the Codex CLI, whose relay refused it).
Taken from zhushenkongjian's tools/review_openai.py. The reviewer reads only its prompt (no tools). Streams the
reply so a long think does not sit on an idle connection. Any failure exits 1 with the reason on stderr; there is
no fallback.

Environment: REVIEW_BASE_URL, REVIEW_API_KEY, REVIEW_MODEL, REVIEW_EFFORT (optional).
"""

import json
import os
import sys
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 900


def request_body(prompt, model, effort):
    body = {"model": model, "stream": True, "messages": [{"role": "user", "content": prompt}]}
    if effort:
        body["reasoning_effort"] = effort
    return body


def endpoint(base_url):
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base + "/v1/chat/completions"


def read_stream(lines):
    """Collect the text of choice 0 of an SSE chat-completions stream; raise on an error event,
    a stream that ends without [DONE], or a reply whose finish_reason is not "stop" (length,
    content_filter, tool_calls or none: an incomplete review must not pass as one)."""
    parts = []
    done = False
    finish = None
    for raw in lines:
        line = raw.decode("utf-8", "replace").strip() if isinstance(raw, bytes) else raw.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            done = True
            break
        event = json.loads(data)
        if event.get("error"):
            raise RuntimeError(f"the endpoint sent an error: {json.dumps(event['error'], ensure_ascii=False)}")
        for choice in event.get("choices") or []:
            if choice.get("index", 0) != 0:
                continue
            content = (choice.get("delta") or {}).get("content")
            if content:
                parts.append(content)
            if choice.get("finish_reason"):
                finish = choice["finish_reason"]
    if not done:
        raise RuntimeError("the stream ended without [DONE]; the reply may be incomplete")
    text = "".join(parts)
    if not text.strip():
        raise RuntimeError("the endpoint returned an empty reply")
    if finish != "stop":
        raise RuntimeError(f"the reply did not finish normally (finish_reason {finish!r}); a cut or filtered review is not a review")
    return text


def main():
    missing = [k for k in ("REVIEW_BASE_URL", "REVIEW_API_KEY", "REVIEW_MODEL") if not os.environ.get(k)]
    if missing:
        sys.exit(f"review_openai.py: missing {', '.join(missing)}")
    try:
        prompt = sys.stdin.buffer.read().decode("utf-8")
    except UnicodeDecodeError as e:
        sys.stderr.write(f"review_openai.py: the prompt on stdin is not valid UTF-8: {e}\n")
        return 1
    body = request_body(prompt, os.environ["REVIEW_MODEL"], os.environ.get("REVIEW_EFFORT", ""))
    req = urllib.request.Request(
        endpoint(os.environ["REVIEW_BASE_URL"]),
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {os.environ['REVIEW_API_KEY']}", "Content-Type": "application/json",
                 "Accept": "text/event-stream"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            text = read_stream(resp)
    except urllib.error.HTTPError as e:
        detail = e.read()[:500].decode("utf-8", "replace")
        sys.stderr.write(f"review_openai.py: HTTP {e.code}: {detail}\n")
        return 1
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as e:
        sys.stderr.write(f"review_openai.py: {e}\n")
        return 1
    sys.stdout.write(text)
    if not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
