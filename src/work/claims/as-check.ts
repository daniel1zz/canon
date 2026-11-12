import { segmentsOf, type Segment } from "./shell-words.ts";

/**
 * What the PreToolUse hook decides about one Bash command (BR-2340, D-62): refuse a canon claim command whose `--as`
 * does not match who runs it, let everything else through, and say when it could not tell.
 */
export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: "unparsable"; readonly sub: string };

/** The `canon work` subcommands that act on a claim; the others (test, status, after-land, clean ...) are not checked. */
const CLAIM_COMMANDS = new Set(["start", "land", "stop", "drop", "take", "unstall"]);
/** Words that put another command in front of the real one. */
const PREFIXES = new Set(["env", "command", "time", "sudo", "exec", "nohup", "nice", "!", "{", "}", "then", "do", "else", "if", "while", "until", "elif"]);
/** Prefixes that take options of their own (`env -i`, `sudo -u x` is not followed). */
const WITH_OPTIONS = new Set(["env", "command", "time", "sudo", "exec", "nohup", "nice"]);
/** Commands that run a command line or another command given to them as text: what they run is not read here. */
const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval", "xargs", "source", ".", "timeout", "watch", "parallel", "find", "setsid", "stdbuf", "flock", "caffeinate", "ssh", "su"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CANON_WORK = /\bcanon\s+work\b/;

const isCanon = (t: string) => t === "canon" || t.endsWith("/canon");

interface Found {
  readonly sub: string;
  /** Values given with `--as`, in order (an option with no value gives ""). */
  readonly as: readonly string[];
}

/** The decision for the command line `command`, run by the subagent `agentId` or, when absent, the main session. */
export function checkCommand(command: string, agentId: string | undefined): Verdict {
  const segments = segmentsOf(command);
  let skipped: string | undefined;
  const found: Found[] = [];
  const anyActor = segments.some((s) => s.words.some((w) => w.text.startsWith("CANON_ACTOR=")));
  for (const seg of segments) {
    const f = claimCommandOf(seg);
    if (f === "unparsable") skipped ??= firstWordAfterCanonWork(seg);
    else if (f) found.push(f);
  }
  for (const f of found) {
    const d = decide(f, agentId, anyActor);
    if (d) return { kind: "deny", reason: d };
  }
  return skipped === undefined ? { kind: "allow" } : { kind: "skip", reason: "unparsable", sub: skipped };
}

function decide(f: Found, agentId: string | undefined, anyActor: boolean): string | undefined {
  const own = agentId === undefined ? "" : ` --as ${agentId}`;
  if (anyActor) return `do not set CANON_ACTOR for canon work ${f.sub}: ${agentId === undefined ? "the main session passes no --as and no CANON_ACTOR" : `a subagent passes only --as ${agentId}`}. Re-run the command without CANON_ACTOR${own === "" ? "" : ` and with${own}`}.`;
  if (agentId === undefined) {
    return f.as.length === 0 ? undefined : `--as is only for subagents; the main session must not pass --as (got --as ${f.as[0]}). Re-run without --as.`;
  }
  if (f.sub === "take") return "canon work take is for the main session only: a subagent must not take over a claim. Do not run it; tell the main session.";
  // reason: a subagent without --as would act as the main session and let its own stopped change land again (BR-2340, BR-2455)
  if (f.sub === "unstall") return "canon work unstall is for the main session only: a subagent must not let its own stopped change land again. Do not run it; report the refusals to the main session.";
  const wrong = f.as.find((v) => v !== agentId);
  if (f.as.length > 0 && wrong === undefined) return undefined;
  const got = f.as.length === 0 ? "" : ` Got --as '${wrong}'.`;
  return `canon work commands run by a subagent must carry your agent id. Re-run the same command with${own} appended (for example: canon work ${f.sub}${own}).${got}`;
}

/** The claim command a segment runs, "unparsable" when it may run one the hook cannot read, undefined when it runs none. */
function claimCommandOf(seg: Segment): Found | "unparsable" | undefined {
  const words = seg.words;
  let k = 0;
  while (k < words.length) {
    const w = words[k]!;
    if (!w.quoted && ASSIGNMENT.test(w.text)) {
      k++;
    } else if (!w.quoted && PREFIXES.has(w.text)) {
      k++;
      if (WITH_OPTIONS.has(w.text)) while (k < words.length && !words[k]!.quoted && words[k]!.text.startsWith("-")) k++;
    } else break;
  }
  const head = words[k];
  const text = [...words.map((x) => x.text), ...seg.heredocs].join(" ");
  const opaque = words.some((x) => x.expands && CANON_WORK.test(x.text));
  if (!head) return opaque ? "unparsable" : undefined;
  if (!isCanon(head.text)) {
    const wraps = WRAPPERS.has(head.text) && (CANON_WORK.test(text) || adjacent(words, k));
    return opaque || wraps ? "unparsable" : undefined;
  }
  if (words[k + 1]?.text !== "work" || words[k + 1]!.quoted) return opaque ? "unparsable" : undefined;
  const sub = words[k + 2];
  if (!sub) return undefined;
  if (sub.expands || sub.quoted) return "unparsable";
  if (!CLAIM_COMMANDS.has(sub.text)) return opaque ? "unparsable" : undefined;
  const as: string[] = [];
  for (let i = k + 3; i < words.length; i++) {
    const a = words[i]!;
    if (a.quoted) continue;
    if (a.text === "--") break;
    if (a.text === "--as") as.push(words[i + 1]?.text ?? "");
    else if (a.text.startsWith("--as=")) as.push(a.text.slice(5));
  }
  return { sub: sub.text, as };
}

/** Whether the words from k on have `canon work` as two neighbouring words (`xargs canon work land`). */
function adjacent(words: readonly { text: string }[], k: number): boolean {
  for (let i = k; i + 1 < words.length; i++) if (isCanon(words[i]!.text) && words[i + 1]!.text === "work") return true;
  return false;
}

function firstWordAfterCanonWork(seg: Segment): string {
  const text = [...seg.words.map((w) => w.text), ...seg.heredocs].join(" ");
  return /\bcanon\s+work\s+([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
}
