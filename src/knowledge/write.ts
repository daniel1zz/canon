import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoordDb } from "../coord/db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { parseDocFile, renderDocFile } from "./docfile.ts";
import { ID_PREFIX, slugify, type Corpus, type Doc, type Kind } from "./model.ts";
import { LORE_DIR } from "./read.ts";

/**
 * Creating documents is the only write lore performs on knowledge files: it allocates the id and lays
 * out the file. Editing a document's text is ordinary file editing by the agent; changing a status goes
 * through `setMeta` so the front matter stays valid.
 */
export interface NewDoc {
  readonly kind: Kind;
  readonly title: string;
  readonly body?: string;
  /** rule only */
  readonly domain?: string;
  readonly untested?: string;
  /** decision only */
  readonly supersedes?: string;
  /** change only */
  readonly rules?: readonly string[];
  /** An id already allocated by the caller (work start allocates the change id before the worktree exists). */
  readonly id?: string;
}

export function highestNumber(corpus: Corpus, prefix: string): number {
  let max = 0;
  for (const d of corpus.docs) {
    const [p, n] = d.id.split("-");
    if (p === prefix) max = Math.max(max, Number(n));
  }
  return max;
}

export function createDoc(root: string, corpus: Corpus, db: CoordDb, actor: string, input: NewDoc): Result<Doc["path"]> {
  const title = input.title.trim();
  if (title === "") return err("invalid", "a title is required");
  const prefix = ID_PREFIX[input.kind];
  let path: string;
  let meta: Record<string, unknown>;
  if (input.kind === "rule") {
    if (!input.domain) return err("invalid", "a rule needs a domain");
    if (!corpus.domains.some((d) => d.name === input.domain)) {
      return err("not_found", `domain ${input.domain} does not exist; create it with \`lore rule domain ${input.domain} --code <dir>\``);
    }
    const id = db.allocate(prefix, highestNumber(corpus, prefix), actor);
    path = join(LORE_DIR, "rules", input.domain, `${id}.md`);
    meta = { id, title, status: "active", untested: input.untested };
  } else {
    if (input.id !== undefined && !input.id.startsWith(`${prefix}-`)) return err("invalid", `${input.id} is not a ${input.kind} id`);
    const id = input.id ?? db.allocate(prefix, highestNumber(corpus, prefix), actor);
    const dir = { decision: "decisions", change: "changes", note: "notes" }[input.kind];
    path = join(LORE_DIR, dir, `${id}-${slugify(title)}.md`);
    meta =
      input.kind === "decision"
        ? { id, title, status: "proposed", supersedes: input.supersedes }
        : input.kind === "change"
          ? { id, title, status: "open", rules: [...(input.rules ?? [])] }
          : { id, title };
  }
  const full = join(root, path);
  if (existsSync(full)) return err("conflict", `${path} already exists`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderDocFile(meta, input.body ?? defaultBody(input.kind)));
  return ok(path);
}

export function createDomain(root: string, name: string, code: readonly string[], description: string): Result<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return err("invalid", "a domain name is lowercase letters, digits and dashes");
  if (code.length === 0) return err("invalid", "a domain must name at least one code directory (--code)");
  const path = join(LORE_DIR, "rules", name, "README.md");
  const full = join(root, path);
  if (existsSync(full)) return err("conflict", `domain ${name} already exists`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderDocFile({ code: [...code] }, `# ${name}\n\n${description || "Scope of this domain."}\n\n## Terms\n`));
  return ok(path);
}

/** Sets front-matter fields of an existing document, leaving the body untouched. */
export function setMeta(root: string, doc: Doc, patch: Record<string, unknown>): Result<void> {
  const full = join(root, doc.path);
  const parsed = parseDocFile(readFileSync(full, "utf8"), doc.path);
  if (!parsed.ok) return parsed;
  writeFileSync(full, renderDocFile({ ...parsed.value.meta, ...patch }, parsed.value.body));
  return ok(undefined);
}

function defaultBody(kind: Kind): string {
  switch (kind) {
    case "rule":
      return "<The rule, stated so a test can decide it. Examples if the boundary is not obvious.>";
    case "decision":
      return "## Context\n\n## Options\n\n## Decision\n\n## Consequences\n";
    case "change":
      return "## Why\n\n## What changes\n\n## Tasks\n\n- [ ] \n";
    case "note":
      return "";
  }
}
