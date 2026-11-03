import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoordDb } from "../coord/db.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { parseDocFile, renderDocFile } from "./docfile.ts";
import { slugify, type Corpus, type Doc } from "./model.ts";
import { CANON_DIR } from "./read.ts";
import { domainReadme, templateFor } from "./templates.ts";
import { typeNamed } from "./types.ts";

/**
 * Creating documents is the only write canon performs on knowledge files: it allocates the id and lays
 * out the file. Editing a document's text is ordinary file editing by the agent; changing a status goes
 * through `setMeta` so the front matter stays valid.
 */
export interface NewDoc {
  /** Type name: rule, decision, change, note, or a type declared in config. */
  readonly kind: string;
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

/**
 * Creates a document of any type the corpus knows: allocates its id, lays out the file, writes the default
 * status, the declared extra fields (empty, to be filled: BR-2054) and the template body.
 */
export function createDoc(root: string, corpus: Corpus, db: CoordDb, actor: string, input: NewDoc, templates: Readonly<Record<string, string>> = {}): Result<Doc["path"]> {
  const title = input.title.trim();
  if (title === "") return err("invalid", "a title is required");
  const type = typeNamed(corpus.types, input.kind);
  if (!type) return err("not_found", `no document type ${input.kind}; declared types: ${corpus.types.map((t) => t.name).join(", ")}`);
  const prefix = type.prefix;
  const extra = Object.fromEntries(type.fields.map((f) => [f, ""]));
  let path: string;
  let meta: Record<string, unknown>;
  if (type.name === "rule") {
    if (!input.domain) return err("invalid", "a rule needs a domain");
    if (!corpus.domains.some((d) => d.name === input.domain)) {
      return err("not_found", `domain ${input.domain} does not exist; create it with \`canon rule domain ${input.domain}\``);
    }
    const id = db.allocate(prefix, highestNumber(corpus, prefix), actor);
    path = join(CANON_DIR, type.dir, input.domain, `${id}.md`);
    meta = { id, title, status: type.defaultStatus, untested: input.untested, ...extra };
  } else {
    if (input.id !== undefined && !input.id.startsWith(`${prefix}-`)) return err("invalid", `${input.id} is not a ${type.name} id`);
    const id = input.id ?? db.allocate(prefix, highestNumber(corpus, prefix), actor);
    const slug = slugify(title);
    path = join(CANON_DIR, type.dir, slug ? `${id}-${slug}.md` : `${id}.md`);
    meta =
      type.name === "decision"
        ? { id, title, status: type.defaultStatus, supersedes: input.supersedes, ...extra }
        : type.name === "change"
          ? { id, title, status: type.defaultStatus, rules: [...(input.rules ?? [])], ...extra }
          : { id, title, status: type.defaultStatus, ...extra };
  }
  const full = join(root, path);
  if (existsSync(full)) return err("conflict", `${path} already exists`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderDocFile(meta, input.body ?? templateFor(type.name, templates, type.sections)));
  return ok(path);
}

/**
 * BR-2115: only a top-level domain of a project without `code_root` names its code (`--code`); a subdomain,
 * or any domain under a code root, is business only and its code is found by convention or through the
 * enclosing domain (D-15).
 */
export function createDomain(root: string, name: string, code: readonly string[], description: string, codeRoot: string | undefined): Result<string> {
  const segments = name.split("/");
  if (!segments.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s))) return err("invalid", "a domain name is lowercase letters, digits and dashes; a subdomain is <domain>/<name> (BR-2113)");
  if (code.length > 0 && segments.length > 1) return err("invalid", `a subdomain names no code (no --code): its code is found through ${segments[0]}`);
  if (code.length > 0 && codeRoot !== undefined) return err("invalid", `no --code with code_root: the domain's code is ${codeRoot}/${name}`);
  if (code.length === 0 && segments.length === 1 && codeRoot === undefined) return err("invalid", "a top-level domain must name at least one code directory (--code), unless canon/config.yaml sets code_root");
  const path = join(CANON_DIR, "rules", ...segments, "README.md");
  const full = join(root, path);
  if (existsSync(full)) return err("conflict", `domain ${name} already exists`);
  const parent = segments.slice(0, -1);
  if (parent.length > 0 && !existsSync(join(root, CANON_DIR, "rules", ...parent, "README.md"))) {
    return err("not_found", `domain ${parent.join("/")} does not exist; create it before its subdomain ${name}`);
  }
  mkdirSync(dirname(full), { recursive: true });
  const body = domainReadme(name, description);
  writeFileSync(full, code.length > 0 ? renderDocFile({ code: [...code] }, body) : body);
  return ok(codeRoot !== undefined ? `${path}\ncode: ${codeRoot}/${name} (create it; canon check reports a domain without its directory)` : path);
}

/** Sets front-matter fields of an existing document, leaving the body untouched. */
export function setMeta(root: string, doc: Doc, patch: Record<string, unknown>): Result<void> {
  const full = join(root, doc.path);
  const parsed = parseDocFile(readFileSync(full, "utf8"), doc.path);
  if (!parsed.ok) return parsed;
  writeFileSync(full, renderDocFile({ ...parsed.value.meta, ...patch }, parsed.value.body));
  return ok(undefined);
}
