import { parse, stringify } from "yaml";
import { err, ok, type Result } from "../kernel/result.ts";

export interface DocFile {
  readonly meta: Record<string, unknown>;
  readonly body: string;
}

const FENCE = "---\n";

/** Splits `---\n<yaml>---\n<body>`. A file without front matter is invalid: every canon document carries an id. */
export function parseDocFile(text: string, path: string): Result<DocFile> {
  if (!text.startsWith(FENCE)) return err("invalid", `${path}: missing front matter`);
  const end = text.indexOf(`\n${FENCE}`, FENCE.length - 1);
  if (end < 0) return err("invalid", `${path}: unterminated front matter`);
  let meta: unknown;
  try {
    meta = parse(text.slice(FENCE.length, end + 1));
  } catch (e) {
    return err("invalid", `${path}: front matter is not valid YAML (${(e as Error).message})`);
  }
  // An empty front matter (`---` directly followed by `---`) is an empty mapping.
  if (meta === null) meta = {};
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return err("invalid", `${path}: front matter must be a mapping`);
  }
  return ok({ meta: meta as Record<string, unknown>, body: text.slice(end + 1 + FENCE.length).replace(/^\n/, "") });
}

/** A domain README carries no id, so front matter is optional: without it the whole text is the body. */
export function parseReadme(text: string, path: string): Result<DocFile> {
  return text.startsWith(FENCE) ? parseDocFile(text, path) : ok({ meta: {}, body: text });
}

export function renderDocFile(meta: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  return `${FENCE}${stringify(clean)}${FENCE}\n${body.trimEnd()}\n`;
}
