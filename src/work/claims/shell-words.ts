/**
 * Splits a Bash command line into command segments of words, only as far as D-62 needs: where one command ends and
 * the next begins, and which words belong to which. It does not run or expand anything: `$(…)`, backticks and
 * variables stay opaque text inside the word that holds them.
 */
export interface Word {
  /** The word with its quotes removed. */
  readonly text: string;
  /** Whether any part of it was quoted or escaped: a quoted `--as` is an argument's text, not the option. */
  readonly quoted: boolean;
  /** Whether it holds a `$(…)`, backtick or `${…}` expansion or a `$name`: its value is not known here. */
  readonly expands: boolean;
}

export interface Segment {
  readonly words: readonly Word[];
  /** The text of the heredoc bodies fed to this segment's command. */
  readonly heredocs: readonly string[];
}

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")"]);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

/** The segments of a command line, in order; segments with no word are dropped. */
export function segmentsOf(input: string): Segment[] {
  const out: Segment[] = [];
  let cur: { words: Word[]; heredocs: string[] } = { words: [], heredocs: [] };
  let text = "";
  let inWord = false;
  let quoted = false;
  let expands = false;
  // Heredocs whose body starts at the next newline: [delimiter, strip leading tabs, owner index into `bodies`]
  let pending: { delim: string; strip: boolean; owner: { heredocs: string[] } }[] = [];
  let i = 0;
  const n = input.length;

  const endWord = () => {
    if (inWord) cur.words.push({ text, quoted, expands });
    text = "";
    inWord = false;
    quoted = false;
    expands = false;
  };
  const endSegment = () => {
    endWord();
    if (cur.words.length > 0) out.push(cur);
    cur = { words: [], heredocs: [] };
  };
  const add = (s: string) => {
    text += s;
    inWord = true;
  };

  // Skips to the matching close of a `$(`, `$((`, `${` or backtick region starting at i (just after the opener); returns the region's text.
  const region = (open: string, close: string): string => {
    let depth = 1;
    let r = "";
    while (i < n && depth > 0) {
      const c = input[i]!;
      if (c === "\\" && i + 1 < n) {
        r += c + input[i + 1];
        i += 2;
        continue;
      }
      if (c === "'" && open !== "`") {
        const end = input.indexOf("'", i + 1);
        const stop = end < 0 ? n : end + 1;
        r += input.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < n && input[j] !== '"') j += input[j] === "\\" ? 2 : 1;
        r += input.slice(i, Math.min(n, j + 1));
        i = Math.min(n, j + 1);
        continue;
      }
      if (c === open && open !== "`") depth++;
      else if (c === close) depth--;
      if (depth > 0) r += c;
      i++;
    }
    return r;
  };

  const readHeredocBodies = () => {
    for (const { delim, strip, owner } of pending) {
      const lines: string[] = [];
      while (i < n) {
        let end = input.indexOf("\n", i);
        if (end < 0) end = n;
        const line = input.slice(i, end);
        i = Math.min(n, end + 1);
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
        lines.push(line);
      }
      owner.heredocs.push(lines.join("\n"));
    }
    pending = [];
  };

  while (i < n) {
    const c = input[i]!;
    if (c === "\\") {
      if (input[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      add(input[i + 1] ?? "");
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      add(input.slice(i + 1, stop));
      quoted = true;
      i = Math.min(n, stop + 1);
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      quoted = true;
      while (i < n && input[i] !== '"') {
        const d = input[i]!;
        if (d === "\\" && i + 1 < n) {
          const e = input[i + 1]!;
          text += e === '"' || e === "\\" || e === "$" || e === "`" ? e : d + e;
          i += 2;
        } else if (d === "$" && input[i + 1] === "(") {
          i += 2;
          text += `$(${region("(", ")")})`;
          expands = true;
        } else if (d === "`") {
          i++;
          text += `\`${region("`", "`")}\``;
          expands = true;
        } else {
          if (d === "$" && /[A-Za-z_{]/.test(input[i + 1] ?? "")) expands = true;
          text += d;
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "$" && input[i + 1] === "(") {
      i += 2;
      add(`$(${region("(", ")")})`);
      expands = true;
      continue;
    }
    if (c === "`") {
      i++;
      add(`\`${region("`", "`")}\``);
      expands = true;
      continue;
    }
    if (c === "$" && input[i + 1] === "{") {
      i += 2;
      add(`\${${region("{", "}")}}`);
      expands = true;
      continue;
    }
    if (c === "$" && /[A-Za-z_]/.test(input[i + 1] ?? "")) expands = true;
    if (c === "#" && !inWord) {
      // a comment runs to the end of the line
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (isSpace(c)) {
      endWord();
      i++;
      continue;
    }
    if (c === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      // a heredoc: `<<`, `<<-`, then its delimiter word (quotes removed)
      endWord();
      i += 2;
      const strip = input[i] === "-";
      if (strip) i++;
      while (i < n && isSpace(input[i]!)) i++;
      let delim = "";
      while (i < n && !isSpace(input[i]!) && !SEPARATORS.has(input[i]!) && input[i] !== "<" && input[i] !== ">") {
        const d = input[i]!;
        if (d === "'" || d === '"') {
          const end = input.indexOf(d, i + 1);
          const stop = end < 0 ? n : end;
          delim += input.slice(i + 1, stop);
          i = Math.min(n, stop + 1);
        } else if (d === "\\") {
          delim += input[i + 1] ?? "";
          i += 2;
        } else {
          delim += d;
          i++;
        }
      }
      pending.push({ delim, strip, owner: cur });
      continue;
    }
    if (c === "&" && (input[i + 1] === ">" || (i > 0 && (input[i - 1] === ">" || input[i - 1] === "<")))) {
      // `&>file`, `2>&1`, `<&3`: part of a redirection, not a separator
      add(c);
      i++;
      continue;
    }
    if (c === "&" || c === "|" || c === ";") {
      endSegment();
      i++;
      while (i < n && (input[i] === c || (c === "|" && input[i] === "&") || (c === ";" && input[i] === "&"))) i++;
      continue;
    }
    if (c === "\n") {
      endSegment();
      i++;
      if (pending.length > 0) readHeredocBodies();
      continue;
    }
    if (c === "(" || c === ")") {
      endSegment();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  endSegment();
  return out;
}
