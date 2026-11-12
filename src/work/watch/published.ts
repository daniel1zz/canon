import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * BR-2224: whether the published canon, the one on PATH that sessions run after this landing, accepts the config of
 * the tree in `wt`. It is asked for the schema it reads configs by (`canon config --schema`, which reads no config,
 * BR-2175), and the config is compared with that schema here, so every key or value it does not know is named.
 * In after mode PATH's canon is published only from a passed commit (BR-2222, BR-2412), so it can be older than main.
 */
export function publishedCanonReads(wt: string, bin: string | null): Result<void> {
  if (!bin) return err("invalid", "canon is not on PATH, so nothing shows that the published canon sessions run after this landing can read its canon/config.yaml (floor_timing: after, BR-2224)");
  const r = Bun.spawnSync([bin, "config", "--schema"], { cwd: wt, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (r.exitCode !== 0) {
    const said = r.stderr.toString().trim().split("\n").slice(0, 5).map((l) => `  ${l}`).join("\n");
    return err("invalid", `the canon on PATH (${bin}) did not print the schema it reads canon/config.yaml by: \`canon config --schema\` exited ${r.exitCode ?? "on a signal"}${said ? `\n${said}` : ""}\nSo nothing shows that it can read this landing's config (BR-2224).`);
  }
  const validate = compiled(r.stdout.toString());
  if (!validate.ok) return err("invalid", `the canon on PATH (${bin}) printed ${validate.error.message} for \`canon config --schema\`, so nothing shows that it can read this landing's config (BR-2224).`);
  const config = configOf(wt);
  if (!config.ok) return config;
  if (validate.value(config.value)) return ok(undefined);
  const { keys, values } = rejected(validate.value.errors ?? []);
  const lines = [
    ...(keys.length > 0 ? [`it does not know ${keys.map((k) => `\`${k}\``).join(", ")}`] : []),
    ...values.map((v) => `it rejects ${v}`),
  ];
  return err(
    "invalid",
    `the published canon on PATH (${bin}), which sessions run after this landing, cannot read this landing's canon/config.yaml:\n${lines.map((l) => `  ${l}`).join("\n")}\n` +
      "It would fail every command with exit 2 (BR-2045). Wait for a release of canon that includes them (main passes its background floor and after_green publishes it), " +
      "then set them in canon/config.yaml in another landing (BR-2224).",
  );
}

type Validate = ReturnType<Ajv["compile"]>;

/** The validator for the schema text a canon printed; a text that is no usable JSON Schema is an error, never "accepts anything". */
function compiled(text: string): Result<Validate> {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    return err("invalid", "output that is not a JSON Schema (not JSON)");
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return err("invalid", "output that is not a JSON Schema (not a JSON object)");
  try {
    return ok(new Ajv({ allErrors: true, strict: false, allowUnionTypes: true }).compile(schema));
  } catch (e) {
    return err("invalid", `output that is not a JSON Schema (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The parsed `canon/config.yaml` of `wt`; an empty mapping when there is none, as canon reads it (BR-2045). */
function configOf(wt: string): Result<unknown> {
  const path = join(wt, "canon/config.yaml");
  if (!existsSync(path)) return ok({});
  try {
    return ok(parse(readFileSync(path, "utf8")) ?? {});
  } catch (e) {
    return err("invalid", `canon/config.yaml of this landing does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The dotted path of a schema error's place in the config (`/hooks/after_land` → `hooks.after_land`). */
const dotted = (instancePath: string) => instancePath.split("/").filter(Boolean).join(".");
const under = (parent: string, key: string) => (parent ? `${parent}.${key}` : key);

/** The keys the schema does not know, by their dotted path, and each rejected value once, by its path and ajv's last word on it. */
function rejected(errors: readonly ErrorObject[]): { keys: string[]; values: string[] } {
  const keys = new Set<string>();
  const values = new Map<string, string>();
  for (const e of errors) {
    const at = dotted(e.instancePath);
    if (e.keyword === "additionalProperties") keys.add(under(at, String((e.params as { additionalProperty: string }).additionalProperty)));
    else if (e.keyword === "propertyNames") keys.add(under(at, String((e.params as { propertyName: string }).propertyName)));
    // reason: ajv reports a failing property name twice, once as the inner error carrying `propertyName`; the propertyNames error names it
    else if ((e as { propertyName?: string }).propertyName === undefined) values.set(at || "(the whole file)", `\`${at || "(the whole file)"}\` (${e.message ?? e.keyword})`);
  }
  return { keys: [...keys], values: [...values.values()] };
}
