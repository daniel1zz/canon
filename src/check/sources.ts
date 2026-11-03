import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isPlaceholderLine, section } from "../knowledge/templates.ts";

/**
 * A decision's options and the sources behind them (D-14). The options section must show a real choice
 * (BR-2109); a source names where a fact comes from and quotes it, so whoever reads the decision, or the
 * landing, can check the quote is really there (BR-2110, BR-2111).
 */
export const OPTIONS_SECTION = "## 方案";
const TAKEN = "采用";
const REJECTED = "否决";
const SOURCE_MARK = "来源：";
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
    if (/^(?:\d+\.|[-*])\s+/.test(line)) items.push(line);
    else if (items.length > 0 && line.trim() !== "" && /^\s/.test(line)) items[items.length - 1] += `\n${line}`;
  }
  return items.filter((i) => !isPlaceholderLine(i.split("\n")[0]!));
}

/** BR-2109: at least two options, each saying whether it was taken or rejected, at least one of each. */
export function optionProblems(body: string): OptionProblem[] {
  if (section(body, OPTIONS_SECTION) === undefined) return [];
  const items = options(body);
  const out: OptionProblem[] = [];
  if (items.length < 2) out.push({ message: `has ${items.length} option(s) under ${OPTIONS_SECTION}; a choice needs at least two` });
  const unmarked = items.filter((i) => !i.includes(TAKEN) && !i.includes(REJECTED));
  for (const i of unmarked) out.push({ message: `option "${firstWords(i)}" says neither ${TAKEN} nor ${REJECTED}` });
  if (items.length >= 2 && !items.some((i) => i.includes(TAKEN))) out.push({ message: `no option under ${OPTIONS_SECTION} is ${TAKEN}` });
  if (items.length >= 2 && !items.some((i) => i.includes(REJECTED))) out.push({ message: `no option under ${OPTIONS_SECTION} is ${REJECTED}` });
  return out;
}

function firstWords(item: string): string {
  const head = item.split("\n")[0]!.replace(/^(?:\d+\.|[-*])\s+/, "");
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
    const path = s.target.replace(/:\d+(?:-\d+)?$/, "");
    const full = resolve(join(root, path));
    if (relative(root, full).startsWith("..") || !existsSync(full) || !statSync(full).isFile()) failures.push(`${path} is not a file in the repository`);
    else if (!collapse(readFileSync(full, "utf8")).includes(want)) failures.push(`${path} does not contain “${want}”`);
  }
  return failures;
}
