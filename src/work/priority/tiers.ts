/**
 * A change's priority tier (D-155): P0 must be done now, P1 urgent, P2 normal (the default), P3 when there is room.
 * Who may set which tier, and how the orderings use it, are BR-2602 to BR-2606.
 */
export const TIERS = ["P0", "P1", "P2", "P3"] as const;
export type Tier = (typeof TIERS)[number];
export const DEFAULT_TIER: Tier = "P2";
