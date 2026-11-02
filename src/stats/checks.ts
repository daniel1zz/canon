/**
 * The checks canon runs at its two boundaries (D-1), by the reason a refusal records. Landing checks are in
 * the order a landing reaches them; `claim` and `setup` guard coordination writes and new worktrees.
 * `canon stats` reports on exactly these names, and `check_reviews` in config may only name them (BR-2069).
 */
export const LAND_STAGES: readonly (readonly string[])[] = [
  ["on-main", "no-floor", "dirty", "no-claim"],
  ["timeout"],
  ["conflict"],
  ["floor"],
  ["check"],
  ["review"],
  ["hook"],
  ["main-moved", "main-dirty"],
];

export const LAND_CHECKS: readonly string[] = LAND_STAGES.flat();
export const CHECKS: readonly string[] = [...LAND_CHECKS, "claim", "setup"];
