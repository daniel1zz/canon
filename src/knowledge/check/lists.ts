import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "../documents/model.ts";

/**
 * BR-2180: a rule that names items of a code list instead of copying the list declares it in front matter
 * (`lists: [{ file, name, items }]`). The check reads the constant's initializer as text, so it works for any
 * language that writes `NAME = <expression>` with string literals: the file exists, it declares `name`, every
 * item is a string literal in that initializer, and the rule's text writes the file, the name and every item in
 * backticks. It runs on every landing, including one that skips the floor (BR-2164), which a test reading the rule
 * would not.
 */
export interface ListFinding {
  readonly path: string;
  readonly message: string;
}

export function listFindings(root: string, corpus: Corpus): ListFinding[] {
  const out: ListFinding[] = [];
  for (const d of corpus.docs) {
    if (d.kind !== "rule" || d.status !== "active" || !d.lists) continue;
    const said = new Set([...d.body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));
    for (const l of d.lists) {
      const where = `${l.file} ${l.name}`;
      const unsaid = [l.file, l.name, ...l.items].filter((x) => !said.has(x));
      if (unsaid.length) out.push({ path: d.path, message: `lists ${where}, but the rule's text does not write ${unsaid.map((x) => `\`${x}\``).join(", ")} in backticks; the text and \`lists\` must name the same things` });
      const full = join(root, l.file);
      if (!existsSync(full) || !statSync(full).isFile()) {
        out.push({ path: d.path, message: `lists ${where}, but ${l.file} is not a file of the repository` });
        continue;
      }
      const init = initializer(readFileSync(full, "utf8"), l.name);
      if (init === undefined) {
        out.push({ path: d.path, message: `lists ${where}, but ${l.file} does not assign ${l.name} (\`${l.name} = ...\`)` });
        continue;
      }
      const literals = new Set([...init.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]!));
      const missing = l.items.filter((i) => !literals.has(i));
      if (missing.length) out.push({ path: d.path, message: `names ${missing.map((x) => `\`${x}\``).join(", ")} from ${where}, which ${missing.length === 1 ? "is" : "are"} not on it; fix the rule's text and \`lists\`, or the code` });
    }
  }
  return out;
}

/**
 * The text after the first `name = ` (a type annotation between them allowed, `==` and `=>` not), up to the first
 * newline or `;` outside brackets and strings once something was read.
 */
export function initializer(source: string, name: string): string | undefined {
  const esc = name.replace(/\$/g, "\\$");
  const m = new RegExp(String.raw`(?<![\w$.])${esc}\s*(?::[^=\n;]*)?=(?![=>])`).exec(source);
  if (!m) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let started = false;
  let i = m.index + m[0].length;
  const begin = i;
  for (; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if ((c === "\n" || c === ";") && depth <= 0 && started) break;
    if (!/\s/.test(c)) started = true;
  }
  return source.slice(begin, i);
}
