import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../../invocation/reference/reference.ts";
import { publishedCanonReads } from "./published.ts";

/** A directory whose `canon/config.yaml` is `config`, and a `canon` that runs `script` (BR-2224). */
function setup(config: string, script: string) {
  const dir = mkdtempSync(join(tmpdir(), "canon-published-"));
  mkdirSync(join(dir, "wt/canon"), { recursive: true });
  writeFileSync(join(dir, "wt/canon/config.yaml"), config);
  const bin = join(dir, "canon");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { wt: join(dir, "wt"), bin };
}

/** A fake canon that prints `schema` for `canon config --schema`. */
const printing = (schema: unknown) => `cat <<'JSON'\n${JSON.stringify(schema)}\nJSON`;

const message = (r: ReturnType<typeof publishedCanonReads>) => (r.ok ? "" : r.error.message);

describe("the published canon's schema decides what a landing's config may use", () => {
  test("BR-2224: a hook name the published schema does not list is named under hooks", () => {
    const { wt, bin } = setup("hooks:\n  after_merge: echo hi\n", printing(configSchema()));
    const r = publishedCanonReads(wt, bin);
    expect(r.ok).toBe(false);
    expect(message(r)).toContain("`hooks.after_merge`");
    expect(message(r)).toContain("Wait for a release");
  });

  test("BR-2224: a check name the published schema does not list is named under check_reviews, once", () => {
    const schema = configSchema() as { properties: Record<string, { propertyNames?: { enum: string[] } }> };
    const reviews = schema.properties["check_reviews"]!;
    const older = { ...schema, properties: { ...schema.properties, check_reviews: { ...reviews, propertyNames: { enum: reviews.propertyNames!.enum.filter((n) => n !== "passes") } } } };
    const { wt, bin } = setup('check_reviews:\n  passes: "2027-02-04"\n  floor: "2027-02-03"\n', printing(older));
    const r = publishedCanonReads(wt, bin);
    expect(message(r)).toContain("`check_reviews.passes`");
    expect(message(r).split("check_reviews.passes").length).toBe(2);
    expect(message(r)).not.toContain("check_reviews.floor");
    // The same config is read by a schema that lists the name.
    const current = setup('check_reviews:\n  passes: "2027-02-04"\n', printing(configSchema()));
    expect(publishedCanonReads(current.wt, current.bin).ok).toBe(true);
  });

  test("BR-2224: a value the published schema rejects is named by its key", () => {
    const { wt, bin } = setup("land_batch_max: 0\n", printing(configSchema()));
    const r = publishedCanonReads(wt, bin);
    expect(r.ok).toBe(false);
    expect(message(r)).toContain("`land_batch_max`");
    expect(message(r)).not.toContain("does not know");
  });

  test("BR-2224: a canon that exits 0 without printing a schema is refused, never taken as accepting", () => {
    const { wt, bin } = setup("land_batch_max: 2\n", "exit 0");
    const r = publishedCanonReads(wt, bin);
    expect(r.ok).toBe(false);
    expect(message(r)).toContain("not a JSON Schema");
    expect(message(r)).toContain(bin);
  });

  test("BR-2224: JSON that is not an object is no schema; the empty object is one that accepts any config", () => {
    const array = setup("land_batch_max: 2\n", "echo '[]'");
    expect(message(publishedCanonReads(array.wt, array.bin))).toContain("not a JSON Schema");
    const empty = setup("anything_at_all: 1\n", "echo '{}'");
    expect(publishedCanonReads(empty.wt, empty.bin).ok).toBe(true);
  });

  test("BR-2224: a canon whose schema command fails is refused with its exit code and stderr", () => {
    const { wt, bin } = setup("land_batch_max: 2\n", "echo boom >&2; exit 2");
    const r = publishedCanonReads(wt, bin);
    expect(message(r)).toContain("exited 2");
    expect(message(r)).toContain("boom");
  });

  test("BR-2224: no canon on PATH is refused", () => {
    const { wt } = setup("land_batch_max: 2\n", "exit 0");
    expect(message(publishedCanonReads(wt, null))).toContain("canon is not on PATH");
  });
});
