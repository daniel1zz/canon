import type { Workspace } from "../workspace.ts";
import { readConfig } from "../../config/config.ts";
import { nowMs } from "../../kernel/clock.ts";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { floorSkip } from "../land/checks/floor.ts";
import { redMain } from "./redmain.ts";

/**
 * When the background floor runs (D-59, BR-2311): main's commits since the last tested one are a backlog, and one
 * run tests all of them once the backlog is due. "Tested" is a floor.pass, floor.fail or floor.skip event on the commit.
 */

/** How far back from main's tip a tested commit is looked for; more untested commits than this are due anyway. */
const SEARCH = 2000;

/** Main's commits that no background floor has covered. */
export interface Backlog {
  /** The newest commit at or below the tip with a floor.pass, floor.fail or floor.skip; null when none within reach. */
  readonly lastTested: string | null;
  /** The commits after it up to the tip, newest first; empty when the tip is tested. */
  readonly commits: readonly string[];
  /** How many of them are landings (land.ok events, BR-2311): canon's own open/close commits are not. */
  readonly landings: number;
  /** When main last moved (ms). */
  readonly movedAt: number;
  /** When main first moved to a commit in the backlog (ms). */
  readonly oldestMovedAt: number;
}

/** The commits `tip` has that no background floor covered, and the landings among them (BR-2311). */
export function readBacklog(ws: Workspace, tip: string): Result<Backlog> {
  const covered = new Set(
    ws.db.db
      .query<{ sha: string | null }, []>("SELECT DISTINCT json_extract(detail, '$.sha') AS sha FROM events WHERE kind IN ('floor.pass', 'floor.fail', 'floor.skip')")
      .all()
      .flatMap((r) => (r.sha ? [r.sha] : [])),
  );
  const list = git(ws.primary, "rev-list", `--max-count=${SEARCH}`, tip);
  if (!list.ok) return err("io", list.error.message);
  const all = list.value === "" ? [] : list.value.split("\n");
  const at = all.findIndex((c) => covered.has(c));
  const commits = at === -1 ? all : all.slice(0, at);
  const lastTested = at === -1 ? null : (all[at] ?? null);
  if (commits.length === 0) return ok({ lastTested, commits, landings: 0, movedAt: 0, oldestMovedAt: 0 });
  const inRange = new Set(commits);
  const landed = ws.db.db.query<{ sha: string | null }, []>("SELECT json_extract(detail, '$.sha') AS sha FROM events WHERE kind = 'land.ok' ORDER BY id DESC LIMIT 5000").all();
  const landings = landed.filter((r) => r.sha && inRange.has(r.sha)).length;
  // reason: the time main moved is read from main's reflog, not from commit dates: a commit made hours ago and fast-forwarded in now moved main now (D-59).
  const reflog = git(ws.primary, "log", "-g", "--format=%H %ct", "-n", "5000", `refs/heads/${ws.config.main}`);
  const moves = (reflog.ok && reflog.value !== "" ? reflog.value.split("\n") : []).map((l) => ({ sha: l.slice(0, 40), at: Number(l.slice(41)) * 1000 })).filter((m) => Number.isFinite(m.at));
  const inBacklog = moves.filter((m) => inRange.has(m.sha));
  const commitDate = (sha: string): Result<number> => {
    const d = git(ws.primary, "log", "-1", "--format=%ct", sha);
    return d.ok ? ok(Number(d.value) * 1000) : err("io", d.error.message);
  };
  const latest = moves[0]?.sha === tip ? moves[0].at : undefined;
  const movedAt = latest ?? (() => { const d = commitDate(tip); return d.ok ? d.value : 0; })();
  const oldest = inBacklog.length > 0 ? Math.min(...inBacklog.map((m) => m.at)) : undefined;
  const oldestMovedAt = oldest ?? (() => { const d = commitDate(commits[commits.length - 1]!); return d.ok ? d.value : movedAt; })();
  return ok({ lastTested, commits, landings, movedAt, oldestMovedAt });
}

/** What the watcher does about main's tip (BR-2311, BR-2312). */
export type Plan =
  | { readonly kind: "idle" }
  | { readonly kind: "skip"; readonly base: string; readonly paths: readonly string[]; readonly under: readonly string[] }
  | { readonly kind: "run"; readonly why: string; readonly backlog: Backlog }
  | { readonly kind: "wait"; readonly at: number; readonly why: string; readonly backlog: Backlog };

/**
 * What to do about `tip`: nothing when it is covered; mark it when only floor_skip_paths changed since the last tested
 * commit (BR-2312); run when `force`, main is failing or a threshold is met; else wait until the earliest due time (BR-2311).
 */
export function plan(ws: Workspace, tip: string, force: boolean): Result<Plan> {
  const backlog = readBacklog(ws, tip);
  if (!backlog.ok) return backlog;
  const b = backlog.value;
  if (b.commits.length === 0) return ok({ kind: "idle" });
  if (b.lastTested !== null) {
    const skip = floorSkip(ws.primary, b.lastTested, tip);
    if (skip) return ok({ kind: "skip", base: b.lastTested, paths: skip.paths, under: skip.under });
  }
  if (force) return ok({ kind: "run", why: "run now was asked for", backlog: b });
  // reason: the floor of a failing main runs back to back, as before, so a fix is confirmed without waiting (BR-2311).
  if (redMain(ws.db)) return ok({ kind: "run", why: "main is failing, so there is no quiet wait", backlog: b });
  if (b.lastTested === null) return ok({ kind: "run", why: "no commit of main is recorded as tested", backlog: b });
  const config = readConfig(ws.primary);
  if (!config.ok) return err(config.error.code, config.error.message);
  const c = config.value;
  const now = nowMs();
  if (b.landings >= c.floorMaxUntested) return ok({ kind: "run", why: `${b.landings} landings are not tested (floor_max_untested ${c.floorMaxUntested})`, backlog: b });
  const quietAt = b.movedAt + c.floorQuietMs;
  const ageAt = b.oldestMovedAt + c.floorMaxAgeMs;
  if (now >= quietAt) return ok({ kind: "run", why: `main has not moved for ${Math.floor((now - b.movedAt) / 60_000)} min (floor_quiet_minutes ${c.floorQuietMs / 60_000})`, backlog: b });
  if (now >= ageAt) return ok({ kind: "run", why: `the oldest untested commit is ${Math.floor((now - b.oldestMovedAt) / 60_000)} min old (floor_max_age_minutes ${c.floorMaxAgeMs / 60_000})`, backlog: b });
  const quietFirst = quietAt <= ageAt;
  return ok({ kind: "wait", at: Math.min(quietAt, ageAt), why: quietFirst ? "main is quiet" : "the oldest untested commit is old enough", backlog: b });
}

/**
 * The line `canon work status` and `canon brief` print while landings are not tested (BR-2313); empty when none are.
 * `plan` is what `plan()` said for the tip.
 */
export function untestedLine(ws: Workspace, p: Plan): string[] {
  if (p.kind !== "run" && p.kind !== "wait") return [];
  const n = p.backlog.landings;
  if (n === 0) return [];
  const noun = `${n} landing${n === 1 ? "" : "s"}`;
  if (p.kind === "run") return [`main: ${noun} not yet tested (the test is due now: ${p.why}; canon floor watch starts it)`];
  const config = readConfig(ws.primary);
  const more = Math.max(1, (config.ok ? config.value.floorMaxUntested : 10) - n);
  const min = Math.max(1, Math.ceil((p.at - nowMs()) / 60_000));
  return [`main: ${noun} not yet tested (next run in ~${min} min, or when ${more} more landing${more === 1 ? "" : "s"} are in; \`canon floor watch --now\` runs it at once)`];
}
