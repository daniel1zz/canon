import type { Finding } from "../../knowledge/check/check.ts";
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
}

export type LandOutcome =
  | { readonly kind: "landed"; readonly sha: string; readonly change: string | null; readonly finished: boolean }
  | { readonly kind: "refused"; readonly reason: "claimed" | "dirty" | "conflict" | "floor" | "config" | "config-key" | "check" | "source" | "secret" | "review" | "hook" | "moved-during-land" | "main-moved" | "main-dirty" | "lost-turn" | "no-floor" | "no-claim" | "lessons" | "on-main" | "environment" | "evidence" | "activate" | "rule-changed" | "passes" | "release" | "stalled"; readonly message: string; readonly findings?: readonly Finding[] }
  | { readonly kind: "timeout"; readonly ahead: number; /** Until when the entry keeps its place (BR-2368); absent when `land_keep_place_minutes` is 0. */ readonly keepsPlaceUntil?: string };

/** What a signal handler must stop: the floor, or the batch worktree's setup, and the review command, while they run. */
export interface Running {
  floor?: { kill(): void } | undefined;
  /** The rule or duplicate review command's process group (BR-2296). */
  review?: { kill(): void } | undefined;
  /** The temporary worktree the review commands run in, while it exists (BR-2216). */
  reviewTree?: string | undefined;
  /** The temporary worktree at the landed commit the review after landing reads the documents from, while it exists (BR-2441). */
  readTree?: string | undefined;
}
