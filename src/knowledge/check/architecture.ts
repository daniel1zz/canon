import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { git } from "../../kernel/git.ts";
import { parseDocFile } from "../documents/docfile.ts";
import { supersedesIds } from "../documents/read.ts";
import { fencedLines, stripCode, type Corpus, type Decision } from "../documents/model.ts";
import { idsIn } from "../documents/types.ts";

/**
 * The architecture overview `canon/architecture.md` and the checks that keep it from lying (D-65, A3 to A5).
 * Nothing here reads source code: it compares directory names, decision ids and git trees, so it holds for any language (D-64).
 */
export const ARCHITECTURE_FILE = "canon/architecture.md";

export type ArchitectureRule = "architecture-unlisted" | "architecture-superseded" | "architecture-unreviewed";

export interface ArchitectureFinding {
  readonly path: string;
  readonly rule: ArchitectureRule;
  readonly message: string;
}

/**
 * What counts as "already there" and what this work is compared with. `refs`: commits whose domains, shared paths and
 * decision links were there before this work (main's tip and this checkout's base, like the backlog, BR-2150); `since`:
 * the commit the overview and the change files are compared with (the base), undefined when there is none.
 */
export interface ArchitectureBase {
  readonly refs: readonly string[];
  readonly since: string | undefined;
}

/** The overview's text; undefined when the project has none. */
export function overviewText(root: string): string | undefined {
  const full = join(root, ARCHITECTURE_FILE);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

/** True when the text holds anything besides front matter, headings and blank lines: only then A2 to A5 apply (D-65). */
export function hasContent(text: string | undefined): boolean {
  if (text === undefined) return false;
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body.split("\n").some((l) => l.trim() !== "" && !/^#{1,6}(\s|$)/.test(l));
}

/** The backticked spans outside code blocks, with a trailing `/` removed; a span must equal a directory whole to name it. */
function fragments(text: string): Set<string> {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const prose = lines.filter((_, i) => !fenced[i]).join("\n");
  return new Set([...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim().replace(/\/+$/, "")));
}

interface Wanted {
  readonly dir: string;
  /** How the finding names it: `domain work/land` or `shared path src/kernel`. */
  readonly what: string;
  /** Tells whether it was there before this work: `domain:<path>` or `shared:<path>`. */
  readonly key: string;
}

/** The code directories the overview must name: each domain's (`<code_root>/<domain path>`) and each shared path (D-65 A3). */
function wanted(corpus: Corpus): Wanted[] {
  const { codeRoot, shared } = corpus.layout;
  if (codeRoot === undefined) return [];
  return [
    ...corpus.domains.map((d) => ({ dir: `${codeRoot}/${d.name}`, what: `domain ${d.name}`, key: `domain:${d.name}` })),
    ...shared.map((s) => ({ dir: s.replace(/\/+$/, ""), what: `shared path ${s}`, key: `shared:${s}` })),
  ];
}

/** The domains and shared paths that exist at `ref`, as `wanted` keys; empty when the commit cannot be read. */
function keysAt(root: string, ref: string): Set<string> {
  const out = new Set<string>();
  const tree = git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref, "--", "canon/rules");
  if (tree.ok) {
    for (const p of tree.value.split("\n")) {
      if (p.startsWith("canon/rules/") && p.endsWith("/README.md")) out.add(`domain:${p.slice("canon/rules/".length, -"/README.md".length)}`);
    }
  }
  const config = git(root, "show", `${ref}:canon/config.yaml`);
  if (config.ok) {
    try {
      const shared = (parse(config.value) as { shared?: unknown } | null)?.shared;
      if (Array.isArray(shared)) for (const s of shared) if (typeof s === "string") out.add(`shared:${s}`);
    } catch {
      // reason: a config that does not parse is refused by every command already (BR-2045); no shared paths known here
    }
  }
  return out;
}

/** The overview names every code directory it must (D-65 A3): the ones missing, split into new in this work and already there. */
function unlisted(root: string, corpus: Corpus, text: string, base: ArchitectureBase | undefined): { added: Wanted[]; existing: Wanted[] } {
  const named = fragments(text);
  const missing = wanted(corpus).filter((w) => !named.has(w.dir));
  if (missing.length === 0) return { added: [], existing: [] };
  const before = new Set((base?.refs ?? []).flatMap((r) => [...keysAt(root, r)]));
  return { added: missing.filter((w) => !before.has(w.key)), existing: missing.filter((w) => before.has(w.key)) };
}

/** The decisions the overview names (backticked ids are examples and do not count, like everywhere in canon). */
function referenced(corpus: Corpus, text: string): Set<string> {
  const ids = idsIn(corpus.types, stripCode(text));
  return new Set([...ids].filter((id) => corpus.docs.some((d) => d.kind === "decision" && d.id === id)));
}

/** The decisions `d` points at in its front matter (`supersedes`, `amends`) at `ref`; undefined when its file is not there. */
function linksAt(root: string, ref: string, d: Decision): Set<string> | undefined {
  const text = git(root, "show", `${ref}:${d.path}`);
  if (!text.ok) return undefined;
  const parsed = parseDocFile(text.value, d.path);
  if (!parsed.ok) return undefined;
  const sup = supersedesIds(parsed.value.meta["supersedes"]);
  const amends = parsed.value.meta["amends"];
  return new Set([...(sup ?? []), ...(Array.isArray(amends) ? amends.filter((a): a is string => typeof a === "string") : [])]);
}

/** The change files this work added or edited since `since`, read from the working tree; every change file when there is no base. */
function touchedChangeTexts(root: string, since: string | undefined, dir: string): string[] {
  let files: string[];
  if (since === undefined) {
    const full = join(root, dir);
    files = existsSync(full) ? readdirSync(full).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`) : [];
  } else {
    const changed = git(root, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", since, "--", dir);
    const added = git(root, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", dir);
    files = [...new Set([...(changed.ok ? changed.value.split("\n") : []), ...(added.ok ? added.value.split("\n") : [])].filter((f) => f !== ""))];
  }
  return files.filter((f) => existsSync(join(root, f))).map((f) => readFileSync(join(root, f), "utf8"));
}

/** The messages of the commits this work made since `since`; none without a base. */
function workMessages(root: string, since: string | undefined): string[] {
  if (since === undefined) return [];
  const log = git(root, "log", "--format=%B%x00", `${since}..HEAD`);
  return log.ok ? log.value.split("\0") : [];
}

/** The line a change file writes to say the overview is not affected, with a real reason after the colon (D-65 A5). */
const UNAFFECTED = /^\s*(?:[-*]\s*)?总览不受影响[：:]\s*(\S.*?)\s*$/gm;
const hasUnaffectedLine = (text: string): boolean => [...text.matchAll(UNAFFECTED)].some((m) => !/^<.*>$/.test(m[1]!));

/** Whether the overview was edited since `since` (it is new, or its text differs). */
function overviewEdited(root: string, text: string, since: string | undefined): boolean {
  if (since === undefined) return true;
  const was = git(root, "show", `${since}:${ARCHITECTURE_FILE}`);
  return !was.ok || was.value.trim() !== text.trim();
}

export interface ArchitectureInput {
  readonly root: string;
  readonly corpus: Corpus;
  readonly architecture?: ArchitectureBase;
}

/** The findings of A3, A4 and A5; none when the overview is missing or holds only its headings (D-65). */
export function architectureFindings(input: ArchitectureInput): ArchitectureFinding[] {
  const text = overviewText(input.root);
  if (!hasContent(text)) return [];
  const { root, corpus } = input;
  const out: ArchitectureFinding[] = [];

  // A3: only the work that adds a domain or shared path is refused for not naming it (like BR-2150); older gaps are `architectureHints`.
  for (const w of unlisted(root, corpus, text!, input.architecture).added) {
    out.push({ path: ARCHITECTURE_FILE, rule: "architecture-unlisted", message: `${w.what} is new, but ${ARCHITECTURE_FILE} names no \`${w.dir}\`; write that directory in backticks under the container that owns it (D-65)` });
  }

  // A4: a decision the overview names was replaced.
  const named = referenced(corpus, text!);
  for (const id of [...named].sort()) {
    const d = corpus.docs.find((x): x is Decision => x.kind === "decision" && x.id === id)!;
    if (d.status !== "superseded") continue;
    const by = corpus.docs.find((x): x is Decision => x.kind === "decision" && x.supersedes.includes(id));
    out.push({ path: ARCHITECTURE_FILE, rule: "architecture-superseded", message: `names ${id}, which is superseded${by ? ` by ${by.id}` : ""}; read what replaced it, update the overview and name the current decision (D-65)` });
  }

  // A5: a new link (`supersedes` or `amends`) to a decision the overview names needs the overview edited in the same work, or a change file saying it is not affected.
  const since = input.architecture?.since;
  const refs = input.architecture?.refs ?? [];
  const fresh: { by: Decision; target: string }[] = [];
  for (const d of corpus.docs) {
    if (d.kind !== "decision") continue;
    const links = [...d.supersedes, ...d.amends].filter((t) => named.has(t));
    if (links.length === 0) continue;
    const there = refs.map((r) => linksAt(root, r, d)).filter((s): s is Set<string> => s !== undefined);
    for (const target of links) if (!there.some((s) => s.has(target))) fresh.push({ by: d, target });
  }
  if (fresh.length > 0 && !overviewEdited(root, text!, since)) {
    const changeDir = corpus.types.find((t) => t.name === "change");
    // reason: a chore has no change file, so the work's own commit messages may carry the line too (BR-2354, #203)
    const said = [...touchedChangeTexts(root, since, `canon/${changeDir?.dir ?? "changes"}`), ...workMessages(root, since)].some(hasUnaffectedLine);
    if (!said) {
      for (const { by, target } of fresh) {
        const how = by.supersedes.includes(target) ? "supersedes" : "amends";
        out.push({ path: by.path, rule: "architecture-unreviewed", message: `${by.id} ${how} ${target}, which ${ARCHITECTURE_FILE} names; update the overview in the same change, or write the line "总览不受影响：<原因>" in the change file (D-65)` });
      }
    }
  }
  return out;
}

/** One hint line when domains or shared paths that were there before this work are missing from the overview (D-65 A3, D-37); none otherwise. */
export function architectureHints(input: ArchitectureInput): string[] {
  const text = overviewText(input.root);
  if (!hasContent(text)) return [];
  const { existing } = unlisted(input.root, input.corpus, text!, input.architecture);
  if (existing.length === 0) return [];
  const names = existing.map((w) => `\`${w.dir}\``);
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "");
  return [`hint architecture: ${ARCHITECTURE_FILE} names no code directory for ${existing.length} domain(s) or shared path(s): ${shown}; write each in backticks under its container`];
}
