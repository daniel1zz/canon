import { err, ok } from "../../kernel/result.ts";
import { configKey, MINUTE } from "../../invocation/key.ts";

/** When the floor runs relative to main moving (D-31): before, the default, or after in the background. */
export type FloorTiming = "before" | "after";

/** canon/config.yaml keys of merge-then-test (D-31). */
export const watchKeys = {
  floorTiming: configKey<FloorTiming>({
    key: "floor_timing",
    doc: "When the floor runs (D-31, BR-2218): `before` (default) tests the tree before main moves; `after` lands without the floor and tests main's latest commit in the background (`canon floor watch`), recording a failure for a fix change.",
    default: "before",
    schema: { enum: ["before", "after"], default: "before" },
    read: (v) => (v === "before" || v === "after" ? ok(v) : err("invalid", "`floor_timing` must be `before` (test, then land; the default) or `after` (land, then test main in the background)")),
    listed: 200,
    checked: 200,
  }),
  floorQuietMs: configKey<number>({
    key: "floor_quiet_minutes",
    doc: "With `floor_timing: after`, the background floor starts once main has not moved for this many minutes (D-59, BR-2311); 0 means no quiet wait. It also starts when `floor_max_untested` or `floor_max_age_minutes` is reached, and at once while main is failing.",
    default: 20 * MINUTE,
    schema: { type: "number", minimum: 0, default: 20 },
    read: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? ok(v * MINUTE) : err("invalid", "`floor_quiet_minutes` must be a number of minutes, 0 or more")),
    listed: 201,
    checked: 201,
  }),
  floorMaxUntested: configKey<number>({
    key: "floor_max_untested",
    doc: "With `floor_timing: after`, the background floor starts once this many landings are not tested yet, however recently main moved (D-59, BR-2311); 1 tests every landing.",
    default: 10,
    schema: { type: "integer", minimum: 1, default: 10 },
    read: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`floor_max_untested` must be a whole number of at least 1")),
    listed: 202,
    checked: 202,
  }),
  floorMaxAgeMs: configKey<number>({
    key: "floor_max_age_minutes",
    doc: "With `floor_timing: after`, the background floor starts once main has moved this many minutes ago to a commit not tested yet, however busy main is (D-59, BR-2311); 0 means no waiting.",
    default: 60 * MINUTE,
    schema: { type: "number", minimum: 0, default: 60 },
    read: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? ok(v * MINUTE) : err("invalid", "`floor_max_age_minutes` must be a number of minutes, 0 or more")),
    listed: 203,
    checked: 203,
  }),
};
