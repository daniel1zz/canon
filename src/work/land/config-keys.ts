import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, MINUTE, optionalString, positiveNumber, positiveValue, REL_DIR, relPath, stringValue } from "../../config/key.ts";

/** canon/config.yaml keys of landing (C-135). */
export const landKeys = {
  main: configKey<string>({
    key: "main",
    doc: "The branch changes land on.",
    default: "main",
    schema: { ...optionalString, default: "main" },
    read: (v) => {
      const s = stringValue("main")(v);
      return s.ok ? ok(s.value ?? "main") : s;
    },
    listed: 10,
    checked: 10,
  }),
  floor: configKey<string | undefined>({
    key: "floor",
    doc: "Shell command that must exit 0 on the exact tree that becomes main (required to land).",
    default: undefined,
    schema: optionalString,
    read: stringValue("floor"),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 20,
    checked: 20,
  }),
  landerStaleMs: configKey<number>({
    key: "lander_stale_minutes",
    doc: "A lander silent this long is skipped (BR-2044).",
    default: 10 * MINUTE,
    schema: positiveNumber(10),
    read: positiveValue("lander_stale_minutes", MINUTE),
    listed: 100,
    checked: 140,
  }),
  landTimeoutMs: configKey<number>({
    key: "land_timeout_minutes",
    doc: "Default wait in the landing queue before giving up (BR-2048).",
    default: 60 * MINUTE,
    schema: positiveNumber(60),
    read: positiveValue("land_timeout_minutes", MINUTE),
    listed: 110,
    checked: 150,
  }),
  floorSkipPaths: configKey<readonly string[]>({
    key: "floor_skip_paths",
    doc: "Repo-relative directories or files the project declares no test reads: a landing that changes only paths under them skips the floor, since its code tree is main's already-tested one (BR-2164). Empty: never skip.",
    default: [],
    schema: { type: ["array", "null"], items: { allOf: [relPath, { not: { enum: ["canon", "canon/config.yaml", "canon/templates"] } }, { not: { type: "string", pattern: "^canon/templates/" } }] }, default: [] },
    read: readFloorSkipPaths,
    listed: 180,
    checked: 100,
  }),
  landBatchMax: configKey<number>({
    key: "land_batch_max",
    doc: "At most this many landings are tested together under one floor run (D-26, BR-2172); 1 means never batch.",
    default: 1,
    schema: { type: "integer", minimum: 1, default: 1 },
    read: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`land_batch_max` must be a whole number of at least 1")),
    listed: 190,
    checked: 160,
  }),
};

/**
 * `floor_skip_paths` (BR-2165): relative paths; none may cover the files that decide how a landing runs (the
 * floor command in canon/config.yaml, the document templates), or a change to them would land untested.
 */
function readFloorSkipPaths(v: unknown): Result<string[]> {
  if (v === null) return ok([]);
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !REL_DIR.test(t))) {
    return err("invalid", "`floor_skip_paths` must be a list of directory or file paths relative to the repository root, such as canon/rules");
  }
  for (const p of v as string[]) {
    if (p === "canon" || p === "canon/config.yaml" || p === "canon/templates" || p.startsWith("canon/templates/")) {
      return err("invalid", `\`floor_skip_paths\` entry \`${p}\` covers canon/config.yaml or canon/templates, which decide how a landing runs; a change to them must run the floor`);
    }
  }
  return ok(v as string[]);
}
