import type { CoordDb } from "../db.ts";
import { redMain } from "../watch/redmain.ts";
import { DEFAULT_TIER, TIERS, type Tier } from "./tiers.ts";

/**
 * The tiers set in the coordination DB (BR-2602, D-155): read on every use, so a tier set now counts at the next read in
 * every worktree. A change with no row is the default P2.
 */

/** Who set a change's tier: the owner (relayed words), the main agent (a reason), or the fix of a failing main (always P0). */
export type SetBy = "owner" | "main-agent" | "fix-main";

export interface Assigned {
  readonly change: string;
  readonly tier: Tier;
  readonly by: SetBy;
  /** The main agent's reason or the owner's relayed words; null for the fix change. */
  readonly words: string | null;
  readonly actor: string | null;
  readonly at: string | null;
  /** The owner's tier, kept as the floor after the main agent raised it (BR-2602); the tier itself when the owner set it. */
  readonly ownerTier: Tier | null;
  readonly ownerWords: string | null;
}

/** Lower is more urgent: P0 is 0. */
export const tierIndex = (t: Tier): number => TIERS.indexOf(t);

export const isTier = (v: string): v is Tier => (TIERS as readonly string[]).includes(v);

interface Row {
  change: string;
  tier: string;
  set_by: string;
  words: string;
  actor: string;
  at: string;
  owner_tier: string | null;
  owner_words: string | null;
}

/**
 * Every change whose tier is not the default, closed changes included (their callers leave those out, BR-2603): a row
 * of `priorities`; else a `canon backlog urgent` mark, which is the owner's P1 (BR-2602, BR-2363); the fix change of a
 * failing main is P0 whatever else is recorded (BR-2221).
 */
export function assignedTiers(db: CoordDb): Map<string, Assigned> {
  const out = new Map<string, Assigned>();
  // reason: a mark written by `canon backlog urgent`, before tiers existed or since, is the owner's P1 (BR-2602, BR-2605)
  for (const m of db.db.query<{ change: string; words: string; actor: string; at: string }, []>("SELECT change, words, actor, at FROM urgent").all()) {
    out.set(m.change, { change: m.change, tier: "P1", by: "owner", words: m.words, actor: m.actor, at: m.at, ownerTier: "P1", ownerWords: m.words });
  }
  for (const r of db.db.query<Row, []>("SELECT change, tier, set_by, words, actor, at, owner_tier, owner_words FROM priorities").all()) {
    if (!isTier(r.tier) || (r.set_by !== "owner" && r.set_by !== "main-agent")) throw new Error(`priorities row for ${r.change} holds tier ${r.tier} set by ${r.set_by}`);
    if (r.owner_tier !== null && !isTier(r.owner_tier)) throw new Error(`priorities row for ${r.change} holds owner tier ${r.owner_tier}`);
    out.set(r.change, { change: r.change, tier: r.tier, by: r.set_by, words: r.words, actor: r.actor, at: r.at, ownerTier: r.owner_tier, ownerWords: r.owner_words });
  }
  const red = redMain(db);
  if (red?.change) out.set(red.change, { change: red.change, tier: "P0", by: "fix-main", words: null, actor: null, at: red.since, ownerTier: null, ownerWords: null });
  return out;
}

/** The tier of `change`: its assigned one, or the default P2. */
export const tierOf = (tiers: ReadonlyMap<string, Assigned>, change: string): Tier => tiers.get(change)?.tier ?? DEFAULT_TIER;

/**
 * Writes the tier the owner or the main agent set. A P2 set on purpose is kept too: the owner's P2 is a floor the main
 * agent cannot go below (BR-2602); only `--clear` returns a change to having no tier set.
 */
export function writeTier(db: CoordDb, a: { change: string; tier: Tier; by: "owner" | "main-agent"; words: string; actor: string; ownerTier: Tier | null; ownerWords: string | null }): void {
  // reason: one fact per change: the owner's later word replaces a `backlog urgent` mark, which would otherwise still say P1
  // (BR-2602, BR-2363); the main agent never reaches here for a marked change: it cannot lower the owner's P1 nor set P0
  if (a.by === "owner") db.db.query("DELETE FROM urgent WHERE change = ?").run(a.change);
  db.db
    .query("INSERT INTO priorities(change, tier, set_by, words, actor, at, owner_tier, owner_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(change) DO UPDATE SET tier = excluded.tier, set_by = excluded.set_by, words = excluded.words, actor = excluded.actor, at = excluded.at, owner_tier = excluded.owner_tier, owner_words = excluded.owner_words")
    .run(a.change, a.tier, a.by, a.words, a.actor, new Date().toISOString(), a.ownerTier, a.ownerWords);
}

/** Back to the default P2: no row, no `backlog urgent` mark. */
export function clearTier(db: CoordDb, change: string): void {
  db.db.query("DELETE FROM urgent WHERE change = ?").run(change);
  db.db.query("DELETE FROM priorities WHERE change = ?").run(change);
}

/** How a tier and who set it read in a list: `P1 main agent`, `P0 fix-main`, `P2` (BR-2603). */
export function tierLabel(a: Assigned | undefined): string {
  if (!a) return DEFAULT_TIER;
  return `${a.tier} ${BY_LABEL[a.by]}`;
}

/** The width of the tier column in `canon change list`: the longest label, `P1 main agent`. */
export const TIER_WIDTH = 13;

export const BY_LABEL: Record<SetBy, string> = { owner: "owner", "main-agent": "main agent", "fix-main": "fix-main" };
