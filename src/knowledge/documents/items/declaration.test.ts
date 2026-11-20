import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../../../invocation/config.ts";
import { parseItemDeclarations } from "./declaration.ts";

/** `types.<type>.items` read on its own (BR-2546): the declaration checks are config errors, named by type, section and reason. */

const MAIN = join(import.meta.dir, "..", "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function repo(config: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "canon-items-decl-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  for (const [path, text] of Object.entries({ "canon/config.yaml": `floor: "true"\ntests: []\n${config}`, ...files })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const items = (declaration: unknown) => parseItemDeclarations("types.adr.items", { 教训: declaration });

describe("declaration checks", () => {
  test("BR-2546: a text slot inside an optional part is a config error naming the type, the section and the reason", () => {
    const r = items({ format: "{text}(?: → {dest})", slots: { text: "text", dest: "text" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("types.adr.items.教训");
    expect(r.error.message).toContain("dest");
    expect(r.error.message).toContain("text slot");
    expect(r.error.message).toContain("optional part");
  });

  test("BR-2546: an enum slot with values and required inside an optional part is valid", () => {
    const r = items({ format: "(?:[{verdict}] ){text}", slots: { verdict: { enum: ["采用", "否决"], required: true }, text: "text" } });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value["教训"]).toEqual({
      format: "(?:[{verdict}] ){text}",
      slots: { verdict: { kind: "enum", values: ["采用", "否决"], required: true }, text: { kind: "text" } },
      onMismatch: "note",
    });
  });

  test("BR-2546: two slots without literal text between them are a config error, and so is a metadata slot outside an optional part", () => {
    const r = items({ format: "{verdict}{text}", slots: { verdict: { enum: ["采用", "否决"], required: true }, text: "text" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("no literal text between them");
    expect(r.error.message).toContain("metadata slot");
    expect(r.error.message).toContain("inside an optional part");
  });

  test("BR-2546: a pattern that is not a valid regular expression is a config error", () => {
    const r = items({ format: "(?:{id})", slots: { id: { pattern: "S\\d+(" } } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("types.adr.items.教训.slots.id.pattern");
    expect(r.error.message).toContain("not a valid regular expression");
  });

  test("BR-2546: a pattern the linear-time engine cannot run is a config error naming the file, the key, the pattern and why", () => {
    const root = repo(`types:\n  adr:\n    prefix: ADR\n    dir: adrs\n    items:\n      教训:\n        format: '{text}(?: [{id}])'\n        slots:\n          text: text\n          id: {pattern: '(?=S)S\\d+'}\n`);
    const r = canon(root, "show", ["AD", "1"].join("R"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("canon/config.yaml");
    expect(r.err).toContain("types.adr.items.教训.slots.id.pattern");
    expect(r.err).toContain(JSON.stringify("(?=S)S\\d+"));
    expect(r.err).toContain("(?=");
  });

  test("BR-2546: a none with a backreference is a config error naming the key and the pattern", () => {
    const r = items({ format: "{text}", slots: { text: "text" }, none: "^(无)\\1$" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("types.adr.items.教训.none");
    expect(r.error.message).toContain(JSON.stringify("^(无)\\1$"));
  });

  test("BR-2546: a pattern that only a backtracking engine would hang on, (a+)+, is a valid declaration", () => {
    const r = items({ format: "{text}(?: [{tag}])", slots: { text: "text", tag: { pattern: "(a+)+" } } });
    expect(r.ok).toBe(true);
  });

  test("BR-2546: on_mismatch must be note or finding", () => {
    const r = items({ format: "(?:[{verdict}] ){text}", slots: { verdict: { enum: ["采用"] }, text: "text" }, on_mismatch: "warn" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("types.adr.items.教训.on_mismatch");
    expect(r.error.message).toContain("note");
    expect(r.error.message).toContain("finding");
  });

  test("BR-2546: none is optional and must be a valid regular expression", () => {
    const valid = items({ format: "{text}", slots: { text: "text" }, none: "^无$" });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("unreachable");
    expect(valid.value["教训"]?.none).toBe("^无$");
    const bad = items({ format: "{text}", slots: { text: "text" }, none: "^无(" });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.error.message).toContain("types.adr.items.教训.none");
    expect(bad.error.message).toContain("not a valid regular expression");
  });

  test("BR-2546: a project cannot declare a section the built-in change type already declares, but may declare another of its sections", () => {
    const redeclared = repo("types:\n  change:\n    items:\n      教训:\n        format: '{text}'\n        slots:\n          text: text\n");
    const r = readConfig(redeclared);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.message).toContain("types.change.items.教训");
    expect(r.error.message).toContain("already declares");
    const other = repo("types:\n  change:\n    items:\n      陷阱和假设:\n        format: '{text}'\n        slots:\n          text: text\n");
    expect(readConfig(other).ok).toBe(true);
  });

  test("BR-2546 BR-2045: a wrong declaration fails every command with exit code 2", () => {
    const root = repo("types:\n  adr:\n    prefix: ADR\n    dir: adrs\n    items:\n      教训:\n        format: '{text}(?: → {dest})'\n        slots:\n          text: text\n          dest: text\n");
    const r = canon(root, "show", ["AD", "1"].join("R"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("canon/config.yaml");
    expect(r.err).toContain("types.adr.items.教训");
    expect(r.err).toContain("optional part");
  });

  test("BR-2546: the other declaration errors are refused too: a slot missing from slots, a slot missing from the template, a duplicate, an unknown type, an enum without values, required on text, nesting and an unclosed part", () => {
    const cases: [string, unknown, string][] = [
      ["slot missing from slots", { format: "(?:{verdict})", slots: { other: { enum: ["x"] } } }, "is in the template but not in slots"],
      ["slot missing from template", { format: "(?:{verdict})", slots: { verdict: { enum: ["x"] }, other: "id" } }, "is in slots but not in the template"],
      ["duplicate slot", { format: "{text}(?:{dest}){text}", slots: { text: "text", dest: { enum: ["x"] } } }, "appears twice"],
      ["unknown type", { format: "{text}", slots: { text: "colour" } }, "unknown slot type"],
      ["enum without values", { format: "(?:{verdict})", slots: { verdict: { enum: [] } } }, "needs a non-empty list of values"],
      ["required on text", { format: "{text}", slots: { text: { text: true, required: true } } }, "a text slot cannot be required"],
      ["nested optional", { format: "(?:(?:[{verdict}] )){text}", slots: { verdict: { enum: ["x"] }, text: "text" } }, "nested"],
      ["unclosed optional", { format: "(?:[{verdict}] {text}", slots: { verdict: { enum: ["x"] }, text: "text" } }, "not closed"],
    ];
    for (const [label, declaration, why] of cases) {
      const r = items(declaration);
      expect([label, r.ok]).toEqual([label, false]);
      if (r.ok) throw new Error("unreachable");
      expect([label, r.error.message.includes(why)]).toEqual([label, true]);
      expect([label, r.error.message.includes("types.adr.items.教训")]).toEqual([label, true]);
    }
  });
});
