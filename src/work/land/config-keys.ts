import { err, ok, type Result } from "../../kernel/result.ts";
import { configKey, type KeyContext, MINUTE, optionalString, positiveNumber, positiveValue, REL_DIR, relPath, stringValue } from "../../invocation/key.ts";

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
    doc: "Shell command that must exit 0 on the exact tree that becomes main (required to land). A `{report}` in it is replaced by the path the command writes a JUnit XML report to, every testcase with a `file`; canon records it for each test file (BR-2339, D-64).",
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
    // reason: a landing may skip the floor only because test_select_command says no test reads its paths, so the one without the other is a config error (BR-2164, D-64)
    needs: ["test_select_command"],
    listed: 180,
    checked: 100,
  }),
  landBatchMax: configKey<number>({
    key: "land_batch_max",
    doc: "At most this many landings are tested together under one floor run (D-26, BR-2172); 1 means never batch, `all` takes every landing waiting in the queue (D-42).",
    default: 1,
    schema: { oneOf: [{ type: "integer", minimum: 1 }, { const: "all" }], default: 1 },
    // reason: `all` has no upper bound, so it is kept as Infinity and every comparison with a count still holds (BR-2172, D-42).
    read: (v) => (v === "all" ? ok(Number.POSITIVE_INFINITY) : typeof v === "number" && Number.isInteger(v) && v >= 1 ? ok(v) : err("invalid", "`land_batch_max` must be a whole number of at least 1, or `all`")),
    listed: 190,
    checked: 160,
  }),
  landKeepPlaceMs: configKey<number>({
    key: "land_keep_place_minutes",
    doc: "A landing refused for a conflict, timed out, stopped by a signal, or marked abandoned by another lander keeps its place in the queue this long: landing the same change again from the same worktree within it puts it back ahead of the entries queued after it (D-29, D-75, BR-2177, BR-2368, BR-2380); 0 sends it to the tail.",
    default: 15 * MINUTE,
    schema: { type: "number", minimum: 0, default: 15 },
    read: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? ok(v * MINUTE) : err("invalid", "`land_keep_place_minutes` must be a number of minutes, 0 or more")),
    listed: 195,
    checked: 165,
  }),
};

/**
 * `floor_skip_paths` (BR-2165): relative paths; none may cover the files that decide how a landing runs (the
 * floor command in canon/config.yaml, the document templates), or a change to them would land untested.
 */
function readFloorSkipPaths(v: unknown, ctx: KeyContext): Result<string[]> {
  if (v === null) return ok([]);
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !REL_DIR.test(t))) {
    return err("invalid", "`floor_skip_paths` must be a list of directory or file paths relative to the repository root, such as canon/rules");
  }
  for (const p of v as string[]) {
    if (p === "canon" || p === "canon/config.yaml" || p === "canon/templates" || p.startsWith("canon/templates/")) {
      return err("invalid", `\`floor_skip_paths\` entry \`${p}\` covers canon/config.yaml or canon/templates, which decide how a landing runs; a change to them must run the floor`);
    }
  }
  // reason: a landing that only changes these paths skips the floor because test_select_command says no test reads them; without the command nothing says so (BR-2164, D-64)
  const select = ctx.raw["test_select_command"];
  if ((v as string[]).length > 0 && (typeof select !== "string" || select === "")) {
    return err("invalid", "`floor_skip_paths` needs `test_select_command`: the command that says which test files a change to those paths can break (e.g. test_select_command: \"bun scripts/select-tests/main.ts\")");
  }
  return ok(v as string[]);
}
