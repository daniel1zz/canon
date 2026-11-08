import { parse } from "yaml";
import type { Say, Workspace } from "../workspace.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { git } from "../../kernel/git.ts";
import { moveMain } from "../land/finish/finish.ts";
import { ensureWatcher } from "../watch/watch.ts";
import { stopGroupSync } from "../verify/stop-groups.ts";
import { remoteKeys } from "./config-keys.ts";

/**
 * Keeps main in step with the configured git remote (D-38): every landing pushes main (BR-2259), a failed push is
 * recorded and leaves the landing as it was (BR-2260), `canon brief` counts what is not pushed (BR-2261), and
 * `canon sync` fast-forwards main to the remote's main only (BR-2262, BR-2263). Only main is pushed or fetched,
 * never a tag, never with --force, never merged.
 */

/** The remote and how long one push or fetch may take, as main's committed canon/config.yaml says. */
export interface RemoteSettings {
  readonly remote: string;
  readonly timeoutMs: number;
}

/**
 * `remote` and `remote_timeout_seconds` from canon/config.yaml as committed on main (D-38): what is pushed is main,
 * so main's config names where. Undefined when main has no config or no `remote`.
 */
export function remoteOnMain(ws: Workspace): Result<RemoteSettings | undefined> {
  const at = `refs/heads/${ws.config.main}:canon/config.yaml`;
  if (!git(ws.primary, "cat-file", "-e", at).ok) return ok(undefined);
  const text = git(ws.primary, "show", at);
  if (!text.ok) return text;
  let raw: Record<string, unknown>;
  try {
    raw = (parse(text.value) as Record<string, unknown> | null) ?? {};
  } catch (e) {
    return err("invalid", `${ws.config.main}'s canon/config.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const ctx = { root: ws.primary, raw };
  const remote = raw["remote"] === undefined ? ok(remoteKeys.remote.default) : remoteKeys.remote.read(raw["remote"], ctx);
  if (!remote.ok) return err("invalid", `${ws.config.main}'s canon/config.yaml: ${remote.error.message}`);
  if (remote.value === undefined) return ok(undefined);
  const t = raw["remote_timeout_seconds"];
  const timeout = t === undefined ? ok(remoteKeys.remoteTimeoutMs.default) : remoteKeys.remoteTimeoutMs.read(t, ctx);
  if (!timeout.ok) return err("invalid", `${ws.config.main}'s canon/config.yaml: ${timeout.error.message}`);
  return ok({ remote: remote.value, timeoutMs: timeout.value });
}

type Timed = { readonly ok: true; readonly out: string } | { readonly ok: false; readonly reason: string };

/** git talking to the remote: never prompts for a password, stopped after `ms` (BR-2260). */
function gitRemote(cwd: string, ms: number, args: readonly string[]): Timed {
  // reason: git leads its own process group so a timeout stops what it started (pre-push hook, receive-pack, ssh), not only git (BR-2260)
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: ms, detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  if (r.exitedDueToTimeout) {
    stopGroupSync(r.pid);
    return { ok: false, reason: `git ${args[0]} was stopped after waiting ${ms / 1000} s (remote_timeout_seconds)` };
  }
  if (r.exitCode === 0) return { ok: true, out: stdout };
  // reason: a rejected ref is a `!` line of --porcelain on stdout; it comes first so the reason starts with what was refused (BR-2261)
  const refused = stdout.split("\n").filter((l) => l.startsWith("!"));
  const said = stderr.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("hint:"));
  const lines = [...refused, ...said];
  return { ok: false, reason: (lines.length > 0 ? lines : [`git ${args[0]} exited ${r.exitCode ?? "on a signal"}`]).slice(0, 10).join("\n") };
}

const trackingRef = (s: RemoteSettings, main: string) => `refs/remotes/${s.remote}/${main}`;

/** Fetches only the remote's main into its remote-tracking ref, no tags. */
function fetchMain(ws: Workspace, s: RemoteSettings, ms: number = s.timeoutMs): Timed {
  const main = ws.config.main;
  return gitRemote(ws.primary, ms, ["fetch", "--no-tags", s.remote, `+refs/heads/${main}:${trackingRef(s, main)}`]);
}

const isAncestor = (ws: Workspace, a: string, b: string) => git(ws.primary, "merge-base", "--is-ancestor", a, b).ok;

/** What one push after a landing did; undefined when no remote is configured. */
export type Pushed = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly sha: string | null; readonly reason: string };

/**
 * Pushes the commit main points at now to the remote's main (BR-2259). A failure is recorded and said, and never
 * changes the landing that called it (BR-2260): this never throws.
 */
export function pushMain(ws: Workspace, say: Say): Pushed | undefined {
  try {
    return push(ws, say);
  } catch (e) {
    // reason: main has already moved; an error here (the coordination DB) is said, the landing stays landed (BR-2260)
    say(`push after landing failed: ${(e as Error).message}`);
    return { ok: false, sha: null, reason: (e as Error).message };
  }
}

function push(ws: Workspace, say: Say): Pushed | undefined {
  const main = ws.config.main;
  const failed = (remote: string | null, sha: string | null, reason: string): Pushed => {
    ws.db.event(ws.actor, "push.fail", null, { remote, sha, reason });
    say(`push to ${remote ?? "the remote"} failed: ${reason}\nThe commits stay on local ${main}; the next landing pushes them again.`);
    return { ok: false, sha, reason };
  };
  const settings = remoteOnMain(ws);
  if (!settings.ok) return failed(null, null, settings.error.message);
  const s = settings.value;
  if (!s) return undefined;
  const tip = git(ws.primary, "rev-parse", "--verify", `refs/heads/${main}`);
  if (!tip.ok) return failed(s.remote, null, tip.error.message);
  const sha = tip.value;
  const startedAt = Date.now();
  const pushed = gitRemote(ws.primary, s.timeoutMs, ["push", "--porcelain", "--no-follow-tags", s.remote, `${sha}:refs/heads/${main}`]);
  let already = false;
  if (!pushed.ok) {
    // reason: a push that read main earlier can arrive after one that read it later and be refused; the remote then
    // already has this commit, which is pushed, not failed, so concurrent landings need no lock (BR-2259)
    // reason: the push and this fetch share one remote_timeout_seconds, so a hanging remote holds the lander for that long, not twice (BR-2260)
    const left = s.timeoutMs - (Date.now() - startedAt);
    const fetched = left > 0 ? fetchMain(ws, s, left) : undefined;
    already = fetched?.ok === true && isAncestor(ws, sha, trackingRef(s, main));
    if (!already) return failed(s.remote, sha, pushed.reason);
  }
  ws.db.event(ws.actor, "push.ok", null, { remote: s.remote, sha, ...(already ? { already: true } : {}) });
  say(`pushed ${sha.slice(0, 9)} to ${s.remote}${already ? ` (${s.remote} already had it)` : ""}`);
  return { ok: true, sha };
}

/**
 * The `canon brief` line counting main's commits the remote-tracking ref does not have (BR-2261), with the reason of
 * the last push when it failed; computed locally, no network. Empty when everything is pushed or no remote is set.
 */
export function unpushedNotice(ws: Workspace): string[] {
  const main = ws.config.main;
  const settings = remoteOnMain(ws);
  if (!settings.ok) return [`Cannot tell which commits are pushed: ${settings.error.message}`];
  const s = settings.value;
  if (!s) return [];
  const tracking = git(ws.primary, "rev-parse", "--verify", "--quiet", trackingRef(s, main));
  const range = tracking.ok && tracking.value !== "" ? `${tracking.value}..refs/heads/${main}` : `refs/heads/${main}`;
  const count = git(ws.primary, "rev-list", "--count", range);
  if (!count.ok) return [`Cannot count the commits not pushed to ${s.remote}: ${count.error.message}`];
  const n = Number(count.value);
  if (n === 0) return [];
  const last = ws.db.db.query<{ kind: string; detail: string }, []>("SELECT kind, detail FROM events WHERE kind IN ('push.ok', 'push.fail') ORDER BY id DESC LIMIT 1").get();
  const reason = last?.kind === "push.fail" ? String((JSON.parse(last.detail) as { reason?: unknown }).reason ?? "").split("\n")[0] : "";
  return [
    `${n} commit(s) on ${main} not pushed to ${s.remote}${reason ? ` (last push failed: ${reason})` : ""}; the next landing pushes them, and \`canon sync\` fast-forwards ${main} when ${s.remote} has commits it lacks`,
  ];
}

/** What `canon sync` did. */
export type Synced =
  | { readonly kind: "up-to-date"; readonly sha: string }
  | { readonly kind: "forwarded"; readonly from: string; readonly to: string }
  | { readonly kind: "ahead"; readonly ahead: number };

/**
 * `canon sync` (BR-2262, BR-2263): fetches the remote's main and fast-forwards local main to it, through the same
 * compare-and-swap with the main guard's marker as a landing (D-16); never merges, rebases or pushes.
 */
export function sync(ws: Workspace, say: Say): Result<Synced> {
  const main = ws.config.main;
  const settings = remoteOnMain(ws);
  if (!settings.ok) return settings;
  const s = settings.value;
  if (!s) return err("invalid", `canon sync needs \`remote\` in ${main}'s canon/config.yaml (the git remote to fast-forward ${main} from)`);
  const refuse = (reason: string, code: "io" | "refused" | "conflict", message: string, detail: Record<string, unknown> = {}): Result<never> => {
    ws.db.event(ws.actor, "sync.refuse", null, { reason, remote: s.remote, message: message.slice(0, 2000), ...detail });
    return err(code, message);
  };
  const fetched = fetchMain(ws, s);
  if (!fetched.ok) return refuse("fetch", "io", `cannot fetch ${main} from ${s.remote}; ${main} was not moved:\n${fetched.reason}`);
  const local = git(ws.primary, "rev-parse", "--verify", `refs/heads/${main}`);
  if (!local.ok) return err("io", local.error.message);
  const theirs = git(ws.primary, "rev-parse", "--verify", trackingRef(s, main));
  if (!theirs.ok) return err("io", theirs.error.message);
  const [l, r] = [local.value, theirs.value];
  if (l === r) {
    say(`${main} is already up to date with ${s.remote} (${l.slice(0, 9)})`);
    return ok({ kind: "up-to-date", sha: l });
  }
  if (isAncestor(ws, l, r)) {
    const moved = moveMain(ws, l, r);
    if (moved !== "moved") return refuse(moved.reason, moved.reason === "environment" ? "io" : "refused", `${moved.message}\n${main} was not fast-forwarded to ${s.remote}'s ${r.slice(0, 9)}`, { from: l, to: r });
    ws.db.event(ws.actor, "sync.ok", null, { remote: s.remote, from: l, to: r });
    say(`fast-forwarded ${main} ${l.slice(0, 9)} to ${s.remote}'s ${r.slice(0, 9)}`);
    // The commits came from the remote, not through a landing; with floor_timing after they are tested like a landing's (BR-2219).
    ensureWatcher(ws, say);
    return ok({ kind: "forwarded", from: l, to: r });
  }
  const count = (range: string) => {
    const c = git(ws.primary, "rev-list", "--count", range);
    return c.ok ? Number(c.value) : NaN;
  };
  if (isAncestor(ws, r, l)) {
    const ahead = count(`${r}..${l}`);
    say(`${main} is ${ahead} commit(s) ahead of ${s.remote}; nothing to fetch, and the next landing pushes them`);
    return ok({ kind: "ahead", ahead });
  }
  const mine = count(`${r}..${l}`);
  const their = count(`${l}..${r}`);
  return refuse(
    "diverged",
    "conflict",
    `${main} and ${s.remote}'s ${main} have diverged: ${main} has ${mine} commit(s) ${s.remote} lacks, ${s.remote} has ${their} commit(s) ${main} lacks.\n` +
      `Nothing was moved; canon never merges them. How to combine them is for a person to decide.`,
    { local: l, theirs: r },
  );
}
