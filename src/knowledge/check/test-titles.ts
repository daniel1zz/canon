/**
 * Test titles in a JS/TS test file (BR-2005): the first argument of each `test`, `it` or `describe` call
 * when it is a string literal. A rule counts as tested only when a title that runs names it, so ids in
 * comments, other strings, or skipped and conditional tests do not count. This is a small lexer, not a
 * parser: it skips comments, strings, template literals and regex literals so that a call written inside
 * a string (a fixture) is not mistaken for a real one.
 */
export interface TestTitle {
  readonly title: string;
  /** False when the call or an enclosing describe is skipped, todo, conditional or otherwise not plainly run. */
  readonly runs: boolean;
  /** 1-based lines of the call's name and of its closing parenthesis: the lines a change touching this test edits (BR-2241). */
  readonly start: number;
  readonly end: number;
}

/** `spans`: on a template literal, how many tokens of its `${…}` expressions follow it. */
/** `at`: offset of the token's first character in the source. */
type Token = { readonly kind: "ident" | "punct" | "string"; readonly text: string; readonly at: number; readonly spans?: number };

const CALLS = new Set(["test", "it", "describe", "xtest", "xit", "xdescribe"]);
// reason: only modifiers that still run the test unconditionally count (BR-2005); `.skip`, `.todo`,
// `.failing`, `.if(…)`, `.skipIf(…)` and anything unknown do not.
const RUNNING = new Set(["only", "each", "concurrent", "serial", "sequential"]);
const WITH_ARGS = new Set(["each", "if", "skipIf", "todoIf", "runIf", "failingIf"]);
const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const regexAllowed = () => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.kind === "string") return false;
    if (prev.kind === "ident") return REGEX_AFTER.has(prev.text);
    return prev.text !== ")" && prev.text !== "]";
  };
  // Lexes to the end, or with stopAtBrace up to and past the `}` that closes a template expression.
  const run = (stopAtBrace: boolean): void => {
    let depth = 0;
    while (i < src.length) {
      const at = i;
      const c = src[i]!;
      const next = src[i + 1];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && next === "/") {
        const end = src.indexOf("\n", i);
        i = end < 0 ? src.length : end;
      } else if (c === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        let text = "";
        while (j < src.length && src[j] !== c && src[j] !== "\n") {
          if (src[j] === "\\") j++;
          text += src[j] ?? "";
          j++;
        }
        out.push({ kind: "string", text, at });
        i = j + 1;
      } else if (c === "`") {
        i++;
        let text = "";
        const inner: Token[] = [];
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") {
            text += src[i + 1] ?? "";
            i += 2;
          } else if (src[i] === "$" && src[i + 1] === "{") {
            i += 2;
            const before = out.length;
            run(true);
            inner.push(...out.splice(before));
            text += " ";
          } else text += src[i++];
        }
        i++;
        // The literal comes first so a title stays the first token after `(`; its expressions follow.
        out.push({ kind: "string", text, at, spans: inner.length }, ...inner);
      } else if (c === "/" && regexAllowed()) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) {
          if (src[j] === "\\") j++;
          else if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          j++;
        }
        j++;
        while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
        out.push({ kind: "punct", text: "regex", at });
        i = j;
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < src.length && /[\w$]/.test(src[j]!)) j++;
        out.push({ kind: "ident", text: src.slice(i, j), at });
        i = j;
      } else if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < src.length && /[\w.]/.test(src[j]!)) j++;
        out.push({ kind: "punct", text: "number", at });
        i = j;
      } else {
        if (stopAtBrace) {
          if (c === "{") depth++;
          else if (c === "}" && depth-- === 0) {
            i++;
            return;
          }
        }
        out.push({ kind: "punct", text: c, at });
        i++;
      }
    }
  };
  run(false);
  return out;
}

/** Index of the `)` matching the `(` at `open`, or the last token when unbalanced. */
function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "punct") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")" && --depth === 0) return k;
  }
  return tokens.length - 1;
}

export function testTitles(src: string): TestTitle[] {
  const tokens = lex(src);
  const breaks: number[] = [];
  for (let n = src.indexOf("\n"); n >= 0; n = src.indexOf("\n", n + 1)) breaks.push(n);
  // 1-based line of an offset: one more than the number of line breaks before it.
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const out: TestTitle[] = [];
  const skippedUntil: number[] = []; // closing index of each enclosing describe that does not run
  for (let i = 0; i < tokens.length; i++) {
    while (skippedUntil.length > 0 && i > skippedUntil[skippedUntil.length - 1]!) skippedUntil.pop();
    const t = tokens[i]!;
    if (t.kind !== "ident" || !CALLS.has(t.text)) continue;
    const prev = tokens[i - 1];
    if (prev?.kind === "punct" && prev.text === ".") continue; // `/x/.test(s)`, `obj.it(…)`
    let runs = !t.text.startsWith("x");
    let k = i + 1;
    while (tokens[k]?.text === "." && tokens[k + 1]?.kind === "ident") {
      const mod = tokens[k + 1]!.text;
      if (!RUNNING.has(mod)) runs = false;
      k += 2;
      if (WITH_ARGS.has(mod) && tokens[k]?.text === "(") k = closing(tokens, k) + 1;
      // reason: `.each` also takes its table as a tagged template, `test.each\`a | b\`("…", fn)` (BR-2005)
      else if (mod === "each" && tokens[k]?.spans !== undefined) k += 1 + tokens[k]!.spans!;
    }
    if (tokens[k]?.kind !== "punct" || tokens[k]!.text !== "(") continue;
    const first = tokens[k + 1];
    const end = closing(tokens, k);
    const enclosingSkipped = skippedUntil.length > 0;
    if (first?.kind === "string") out.push({ title: first.text, runs: runs && !enclosingSkipped, start: lineOf(t.at), end: lineOf(tokens[end]?.at ?? src.length) });
    if (!runs && t.text.endsWith("describe")) skippedUntil.push(end);
  }
  return out;
}
