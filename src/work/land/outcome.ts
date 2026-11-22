import type { Finding } from "../../knowledge/check/check.ts";
import type { Result } from "../../kernel/result.ts";
import type { Passed } from "../verify/load-gate.ts";
import type { Fetcher } from "../../knowledge/check/sources.ts";

export interface LandOptions {
  /** Close the change (status done) and remove its worktree after landing. */
  readonly finish: boolean;
  /** Give up waiting for the queue after this long. */
  readonly timeoutMs: number;
  /** The run directory of the background landing this process is (D-80); recorded in `land.start` so the landing can be followed again. */
  readonly run?: string;
  /** How decision sources given as URLs are fetched (BR-2111); the network unless a test supplies one. */
  readonly fetcher?: Fetcher;
  /** The workflow guide `canon brief` prints, one of the standing texts the duplicate review compares (BR-2143). */
  readonly guide?: string;
  /**
   * With `finish`, how the landed worktree is removed (BR-2486): `background` (the default) once nothing runs inside it;
   * `now`, in this process, for a landing started from the primary checkout (canon update and uninstall), where nothing does.
   */
  readonly removeWorktree?: "background" | "now";
}

export type LandOutcome =
  | { readonly kind: "landed"; readonly sha: string; readonly change: string | null; readonly subject?: string | null; readonly workKind?: "change" | "chore"; readonly finished: boolean }
  | { readonly kind: "refused"; readonly reason: "claimed" | "dirty" | "conflict" | "floor" | "config" | "config-key" | "check" | "source" | "review" | "hook" | "moved-during-land" | "main-moved" | "main-dirty" | "lost-turn" | "no-floor" | "no-claim" | "lessons" | "owner-gate" | "on-main" | "environment" | "evidence" | "activate" | "rule-changed" | "passes" | "release" | "quality" | "stalled" | "tests" | "delegation" | "fields"; readonly message: string; readonly findings?: readonly Finding[] }
  | { readonly kind: "timeout"; readonly ahead: number; /** Until when the entry keeps its place (BR-2368); absent when `land_keep_place_minutes` is 0. */ readonly keepsPlaceUntil?: string };

/** What a signal handler must stop: the commands the landing started and the review command, while they run. */
export interface Running {
  /**
   * The process groups of the commands the landing started that may still have a process: the floor, the batch's setup,
   * each before_land command and the test files it runs itself. A signal stops them all, children included (BR-2099, #262).
   */
  groups?: Set<number> | undefined;
  /** The rule or duplicate review command's process group (BR-2296). */
  review?: { kill(): void } | undefined;
  /**
   * The landing's pass through the load gate, made once at the first heavy step of the turn: the floor or the test files
   * it runs itself (BR-2630). Later steps and the batch's members get the same answer.
   */
  gate?: (() => Promise<Result<Passed>>) | undefined;
  /** The temporary worktree the review commands run in, while it exists (BR-2216). */
  reviewTree?: string | undefined;
  /** The temporary worktree at the landed commit the review after landing reads the documents from, while it exists (BR-2441). */
  readTree?: string | undefined;
}

/** The set of process groups a signal to the landing stops (BR-2099); a command started with `detached: true` adds its own. */
export const landingGroups = (running: Running): Set<number> => (running.groups ??= new Set());
