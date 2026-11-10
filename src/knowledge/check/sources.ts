import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPlaceholderLine, LIST_MARKER, section } from "../documents/templates.ts";

/**
 * A decision's options and the sources behind them (D-14). The options section must show a real choice
 * (BR-2109); a source names where a fact comes from and quotes it, so whoever reads the decision, or the
 * landing, can check the quote is really there (BR-2110, BR-2111).
 */
export const OPTIONS_SECTION = "## 方案";
const TAKEN = "采用";
const REJECTED = "否决";
/** 采用 not negated: 不采用, 未采用, 没采用, 没有采用 and 不再采用 say the option was rejected (BR-2109). */
const TAKEN_MARK = /(?<!不|未|没|没有|不再)采用/;
const NEGATED_TAKEN = /(?:不|未|没|没有|不再)采用/;
export const SOURCE_MARK = "来源：";
/** Shortest quote, after whitespace is collapsed: a few characters match almost any page. */
export const MIN_QUOTE = 8;

export interface Source {
  readonly target: string;
  readonly quote: string;
  readonly line: string;
}

export interface OptionProblem {
  readonly message: string;
}

/** Top-level list items of the options section, each with its continuation lines. */
export function options(body: string): string[] {
  const text = section(body, OPTIONS_SECTION);
  if (text === undefined) return [];
  const items: string[] = [];
  for (const line of text.split("\n")) {
    if (LIST_MARKER.test(line)) items.push(line);
    else if (items.length > 0 && line.trim() !== "" && /^\s/.test(line)) items[items.length - 1] += `\n${line}`;
  }
  return items.filter((i) => !isPlaceholderLine(i.split("\n")[0]!));
}

/** BR-2109: at least two options, each saying whether it was taken or rejected, at least one of each. */
export function optionProblems(body: string): OptionProblem[] {
  const text = section(body, OPTIONS_SECTION);
  if (text === undefined) return [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  // reason: a section of template placeholders only is the unfilled template, which template-unfilled and
  // doc-missing-section already report; a third finding for the same cause adds nothing (BR-2109)
  if (lines.length > 0 && lines.every(isPlaceholderLine)) return [];
  const items = options(body);
  const taken = (i: string) => TAKEN_MARK.test(verdictText(i));
  const rejected = (i: string) => verdictText(i).includes(REJECTED) || NEGATED_TAKEN.test(verdictText(i));
  const out: OptionProblem[] = [];
  if (items.length < 2) out.push({ message: `has ${items.length} option(s) under ${OPTIONS_SECTION}; a choice needs at least two` });
  for (const i of items.filter((i) => !taken(i) && !rejected(i))) out.push({ message: `option "${firstWords(i)}" says neither ${TAKEN} nor ${REJECTED}` });
  if (items.length >= 2 && !items.some(taken)) out.push({ message: `no option under ${OPTIONS_SECTION} is ${TAKEN}` });
  if (items.length >= 2 && !items.some(rejected)) out.push({ message: `no option under ${OPTIONS_SECTION} is ${REJECTED}` });
  return out;
}

/**
 * The part of an option that states the author's verdict: its source lines and anything in quotes (“…”, `…`)
 * are other people's words, so a 采用 or 否决 there marks nothing (BR-2109).
 */
function verdictText(item: string): string {
  return item
    .split("\n")
    .filter((l, n) => n === 0 || !l.includes(SOURCE_MARK))
    .join("\n")
    .replace(/“[^”]*”/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function firstWords(item: string): string {
  const head = item.split("\n")[0]!.replace(LIST_MARKER, "");
  return head.length > 30 ? `${head.slice(0, 30)}…` : head;
}

const SOURCE_LINE = /来源：\s*(\S+)\s+“([^”]+)”/;

/** Sources cited in the options section, and lines that mention a source but do not parse (BR-2110). */
export function sources(body: string): { sources: Source[]; malformed: string[] } {
  const text = section(body, OPTIONS_SECTION) ?? "";
  const out: Source[] = [];
  const malformed: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(SOURCE_MARK) || isPlaceholderLine(line)) continue;
    const m = SOURCE_LINE.exec(line);
    if (!m) {
      malformed.push(line.trim());
      continue;
    }
    const [, target, quote] = m as unknown as [string, string, string];
    if (!/^https?:\/\//.test(target) && (isAbsolute(target) || target.split("/").includes(".."))) malformed.push(line.trim());
    else if (collapse(quote).length < MIN_QUOTE) malformed.push(line.trim());
    else out.push({ target, quote, line: line.trim() });
  }
  return { sources: out, malformed };
}

/** Whitespace collapsed to single spaces, so a quote matches across line breaks and indentation. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The visible text of an HTML page: scripts, styles and tags dropped, entities decoded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
}

export type Fetcher = (url: string) => Promise<{ status: number; text: string }>;

export const httpFetch: Fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "canon-source-check" } });
  return { status: r.status, text: await r.text() };
};

/**
 * BR-2111: whether each source's quote is really in what it names. A repository path is read from `root`
 * (the tree that becomes main); a URL is fetched. Returns one message per source that does not hold.
 */
export async function verify(root: string, list: readonly Source[], fetcher: Fetcher = httpFetch): Promise<string[]> {
  const failures: string[] = [];
  for (const s of list) {
    const want = collapse(s.quote);
    if (/^https?:\/\//.test(s.target)) {
      let got: { status: number; text: string };
      try {
        got = await fetcher(s.target);
      } catch (e) {
        failures.push(`${s.target} could not be fetched (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      if (got.status < 200 || got.status >= 300) failures.push(`${s.target} answered HTTP ${got.status}`);
      else if (!collapse(pageText(got.text)).includes(want)) failures.push(`${s.target} does not contain “${want}”`);
      continue;
    }
    const failure = fileSourceFailure(root, s);
    if (failure !== undefined) failures.push(failure.message);
  }
  return failures;
}

/** A repository-path source's file, without its `:line` or `:from-to` suffix. */
export function sourceFile(s: Source): string {
  return s.target.replace(/:\d+(?:-\d+)?$/, "");
}

/**
 * Why a repository-path source does not hold in the tree at `root`, or undefined when it does: its file must be a
 * file there and hold the quote, whitespace collapsed on both sides. The one matcher behind the landing's check of
 * new sources (BR-2111) and `canon check`'s offline check of every current decision's sources (BR-2252).
 */
export function fileSourceFailure(root: string, s: Source): { kind: "no-file" | "no-quote" | "link"; message: string } | undefined {
  const path = sourceFile(s);
  const full = resolve(join(root, path));
  const inside = relative(resolve(root), full);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return { kind: "no-file", message: `${path} is not a file in the repository` };
  // reason: a link is never followed, so a link to a file outside the repository cannot be read, or probed for
  // existence, through a source (BR-2186, BR-2252); only the parts below root count, root itself may sit under one
  let at = resolve(root);
  for (const part of inside.split(sep)) {
    at = join(at, part);
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return { kind: "no-file", message: `${path} is not a file in the repository` };
    }
    if (link) return { kind: "link", message: `${path} is a symbolic link; canon does not follow links, so it was not read` };
  }
  if (!existsSync(full) || !statSync(full).isFile()) return { kind: "no-file", message: `${path} is not a file in the repository` };
  const want = collapse(s.quote);
  if (!collapse(readFileSync(full, "utf8")).includes(want)) return { kind: "no-quote", message: `${path} does not contain “${want}”` };
  return undefined;
}
