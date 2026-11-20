import { err, ok, type Result } from "../../../kernel/result.ts";

/**
 * The parts of an item template (BR-2546): literal text, a slot `{name}`, and an optional part `(?:…)`. Optional
 * parts are not nested; a metadata slot is written inside one. Parsing is separate from the declaration checks in
 * `declaration.ts` and from matching in `read.ts`, so both read one syntax.
 */
export type TemplatePart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "slot"; readonly name: string }
  | { readonly kind: "optional"; readonly parts: readonly TemplatePart[] };

/**
 * Parses a template (BR-2546). The error names what is wrong with the template alone; the caller prefixes
 * `types.<type>.items.<section>.format`, so the message names the type, the section and the reason.
 */
export function parseTemplate(format: string): Result<readonly TemplatePart[]> {
  const out: TemplatePart[] = [];
  // reason: optionals do not nest, so one stack entry is enough to tell a stray `)` from a closed part, but the
  // stack also holds where literals and slots go while inside one (BR-2546)
  const stack: TemplatePart[][] = [];
  let literal = "";
  const target = () => (stack.length > 0 ? stack[stack.length - 1]! : out);
  const flush = () => {
    if (literal !== "") {
      target().push({ kind: "literal", text: literal });
      literal = "";
    }
  };
  let i = 0;
  while (i < format.length) {
    const c = format[i]!;
    if (c === "{") {
      const end = format.indexOf("}", i + 1);
      if (end < 0) return err("invalid", `a slot is not closed with "}": ${JSON.stringify(format.slice(i))}`);
      const name = format.slice(i + 1, end);
      if (name === "" || /\s/.test(name) || name.includes("{")) {
        return err("invalid", `a slot name must be non-empty and contain no spaces: ${JSON.stringify(format.slice(i, end + 1))}`);
      }
      flush();
      target().push({ kind: "slot", name });
      i = end + 1;
    } else if (c === "(") {
      if (!format.startsWith("(?:", i)) return err("invalid", `an optional part starts with "(?:"; a plain "(" cannot appear in a template`);
      // reason: an optional part cannot nest (BR-2546)
      if (stack.length > 0) return err("invalid", `an optional part is nested inside another one`);
      flush();
      stack.push([]);
      i += 3;
    } else if (c === ")") {
      if (stack.length === 0) return err("invalid", `a ")" does not close an optional part`);
      flush();
      const parts = stack.pop()!;
      target().push({ kind: "optional", parts });
      i += 1;
    } else {
      literal += c;
      i += 1;
    }
  }
  if (stack.length > 0) return err("invalid", `an optional part is not closed with ")"`);
  flush();
  return ok(out);
}
