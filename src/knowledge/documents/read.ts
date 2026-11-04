import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocFile, parseReadme } from "./docfile.ts";
import { parsePasses } from "./behaviour.ts";
import { NO_LAYOUT, type ChangeStatus, type Corpus, type CodeList, type DecisionStatus, type Doc, type Domain, type Layout, type RuleStatus } from "./model.ts";
import { BUILTIN_TYPES, type DocType } from "./types.ts";

/** A file under canon/ that does not fit the model. `canon check` reports these; reading never stops on one. */
export interface FileProblem {
  readonly path: string;
  readonly message: string;
}

export interface ReadResult {
  readonly corpus: Corpus;
  readonly problems: readonly FileProblem[];
}

export const CANON_DIR = "canon";

/**
 * Reads every knowledge document under `<root>/canon`, for the built-in types and any declared in config.
 * Files that do not parse become problems, not exceptions. A document missing a declared field is still
 * read (so references to it resolve) and the missing field is reported (BR-2054).
 */
export function readCorpus(root: string, types: readonly DocType[] = BUILTIN_TYPES, layout: Layout = NO_LAYOUT): ReadResult {
  const { codeRoot, shared } = layout;
  const docs: Doc[] = [];
  const domains: Domain[] = [];
  const problems: FileProblem[] = [];
  const base = join(root, CANON_DIR);
  const rel = (p: string) => relative(root, p);
  const numbers: Record<string, number> = {};
  // reason: counted from the file name before parsing, so an invalid file's number is never reused (BR-2002)
  const seen = (prefix: string, file: string): void => {
    const m = new RegExp(`^${prefix}-(\\d+)(?![0-9])`).exec(file);
    if (m) numbers[prefix] = Math.max(numbers[prefix] ?? 0, Number(m[1]));
  };

  const parse = (full: string, type: DocType, id: string): { meta: Record<string, unknown>; body: string; status: unknown } | undefined => {
    const path = rel(full);
    const parsed = parseDocFile(readFileSync(full, "utf8"), path);
    if (!parsed.ok) {
      problems.push({ path, message: parsed.error.message });
      return undefined;
    }
    const { meta, body } = parsed.value;
    const status = meta["status"] ?? type.defaultStatus;
    const bad =
      checkCommon(meta, id) ??
      (type.statuses && !type.statuses.includes(status as string) ? `status must be one of ${type.statuses.join(", ")}` : undefined);
    if (bad) {
      problems.push({ path, message: bad });
      return undefined;
    }
    for (const field of type.fields) {
      const v = meta[field];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)) {
        problems.push({ path, message: `front matter \`${field}\` is required for a ${type.name} (canon/config.yaml types.${type.name}.fields)` });
      }
    }
    return { meta, body, status };
  };

  const ruleType = types.find((t) => t.name === "rule")!;
  const rulesDir = join(base, ruleType.dir);
  const ruleFile = new RegExp(`^${ruleType.prefix}-\\d+\\.md$`);
  // reason: a domain may hold subdomains as subdirectories; each level is a domain of its own (BR-2113)
  const walk = (domain: string, parent: string | undefined): void => {
    const dir = join(rulesDir, ...domain.split("/"));
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) problems.push({ path: rel(dir), message: "domain has no README.md (scope, code directories, Terms)" });
    else {
      const parsed = parseReadme(readFileSync(readme, "utf8"), rel(readme));
      if (!parsed.ok) problems.push({ path: rel(readme), message: parsed.error.message });
      else {
        const code = parsed.value.meta["code"];
        const declared = Array.isArray(code) ? code.filter((c): c is string => typeof c === "string") : [];
        // reason: only a top-level domain without a code root names its code; otherwise the location is the
        // convention or the enclosing domain's, and a stray `code:` is a check finding, not a read problem (D-15, BR-2117)
        const named = codeRoot === undefined && !parent;
        if (named && declared.length === 0) problems.push({ path: rel(readme), message: "front matter `code` must list at least one code directory this domain governs (or set code_root in canon/config.yaml)" });
        const effective = codeRoot !== undefined ? [`${codeRoot}/${domain}`] : named ? declared : [];
        domains.push({ name: domain, path: rel(readme), code: effective, declared, body: parsed.value.body, ...(parent ? { parent } : {}) });
      }
    }
    for (const file of listFiles(dir)) {
      if (file === "README.md") continue;
      seen(ruleType.prefix, file);
      const full = join(dir, file);
      if (!ruleFile.test(file)) {
        problems.push({ path: rel(full), message: `a rule file must be named ${ruleType.prefix}-<n>.md` });
        continue;
      }
      const id = file.slice(0, -3);
      const p = parse(full, ruleType, id);
      if (!p) continue;
      const untested = p.meta["untested"];
      if (untested !== undefined && (typeof untested !== "string" || untested.trim() === "")) {
        problems.push({ path: rel(full), message: "`untested` must state the reason the rule has no test" });
        continue;
      }
      const lists = codeLists(p.meta["lists"]);
      if (typeof lists === "string") {
        problems.push({ path: rel(full), message: lists });
        continue;
      }
      docs.push({
        kind: "rule",
        id,
        title: String(p.meta["title"]),
        path: rel(full),
        body: p.body,
        domain,
        status: p.status as RuleStatus,
        ...(typeof untested === "string" ? { untested } : {}),
        ...(lists.length > 0 ? { lists } : {}),
      });
    }
    for (const sub of listDirs(dir)) walk(`${domain}/${sub}`, domain);
  };
  for (const domain of listDirs(rulesDir)) walk(domain, undefined);

  for (const type of types) {
    if (type.name === "rule") continue;
    const dir = join(base, type.dir);
    const numbered = new RegExp(`^${type.prefix}-\\d+(-[a-z0-9-]+)?\\.md$`);
    for (const file of listFiles(dir)) {
      seen(type.prefix, file);
      const full = join(dir, file);
      const path = rel(full);
      if (!numbered.test(file)) {
        problems.push({ path, message: `file name must look like ${type.prefix}-<n>.md or ${type.prefix}-<n>-<slug>.md` });
        continue;
      }
      const id = file.match(/^[A-Z][A-Z0-9]*-\d+/)![0];
      const p = parse(full, type, id);
      if (!p) continue;
      const common = { id, title: String(p.meta["title"]), path, body: p.body };
      if (type.name === "decision") {
        const supersedes = p.meta["supersedes"];
        const amends = p.meta["amends"] ?? [];
        if (!Array.isArray(amends) || amends.some((a) => typeof a !== "string")) {
          problems.push({ path, message: "`amends` must be a list of decision ids" });
          continue;
        }
        docs.push({ kind: "decision", ...common, status: p.status as DecisionStatus, ...(typeof supersedes === "string" ? { supersedes } : {}), amends: amends as string[] });
      } else if (type.name === "change") {
        const rules = p.meta["rules"] ?? [];
        if (!Array.isArray(rules) || rules.some((r) => typeof r !== "string")) {
          problems.push({ path, message: "`rules` must be a list of rule ids" });
          continue;
        }
        const passes = parsePasses(p.meta["passes"]);
        if (typeof passes === "string") {
          problems.push({ path, message: passes });
          continue;
        }
        docs.push({ kind: "change", ...common, status: p.status as ChangeStatus, rules: rules as string[], passes });
      } else if (type.name === "note") {
        docs.push({ kind: "note", ...common });
      } else {
        docs.push({ kind: "extra", type: type.name, ...common, status: p.status as string | undefined });
      }
    }
  }
  return { corpus: { docs, domains, types, layout: { codeRoot, shared }, numbers }, problems };
}

function checkCommon(meta: Record<string, unknown>, idFromName: string): string | undefined {
  if (meta["id"] !== idFromName) return `front matter id ${JSON.stringify(meta["id"])} does not match the file name (${idFromName})`;
  if (typeof meta["title"] !== "string" || meta["title"].trim() === "") return "front matter `title` is required";
  return undefined;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".md") && statSync(join(dir, n)).isFile()).sort();
}

/** A rule's `lists` front matter (BR-2180), or the problem with it. */
function codeLists(v: unknown): CodeList[] | string {
  if (v === undefined) return [];
  const bad = "`lists` must be a list of { file, name, items } entries: a repository path, the constant's name, and the names the rule uses from it (BR-2180)";
  if (!Array.isArray(v) || v.length === 0) return bad;
  const out: CodeList[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return bad;
    const { file, name, items, ...rest } = e as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return bad;
    if (typeof file !== "string" || file.trim() === "" || file.startsWith("/") || file.split("/").includes("..")) return bad;
    if (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name)) return bad;
    if (!Array.isArray(items) || items.length === 0 || items.some((i) => typeof i !== "string" || i === "")) return bad;
    out.push({ file, name, items: items as string[] });
  }
  return out;
}
