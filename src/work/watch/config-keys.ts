import { err, ok } from "../../kernel/result.ts";
import { configKey } from "../../config/key.ts";

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
};
