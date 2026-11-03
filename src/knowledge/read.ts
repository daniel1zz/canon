import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocFile } from "./docfile.ts";
import type { ChangeStatus, Corpus, DecisionStatus, Doc, Domain, RuleStatus } from "./model.ts";
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
export function readCorpus(root: string, types: readonly DocType[] = BUILTIN_TYPES): ReadResult {
  const docs: Doc[] = [];
  const domains: Domain[] = [];
  const problems: FileProblem[] = [];
  const base = join(root, CANON_DIR);
  const rel = (p: string) => relative(root, p);

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
      const parsed = parseDocFile(readFileSync(readme, "utf8"), rel(readme));
      if (!parsed.ok) problems.push({ path: rel(readme), message: parsed.error.message });
      else {
        const code = parsed.value.meta["code"];
        const codeList = Array.isArray(code) ? code.filter((c): c is string => typeof c === "string") : [];
        if (!Array.isArray(code) || codeList.length === 0) problems.push({ path: rel(readme), message: "front matter `code` must list at least one code directory this domain governs" });
        domains.push({ name: domain, path: rel(readme), code: codeList, body: parsed.value.body, ...(parent ? { parent } : {}) });
      }
    }
    for (const file of listFiles(dir)) {
      if (file === "README.md") continue;
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
      docs.push({
        kind: "rule",
        id,
        title: String(p.meta["title"]),
        path: rel(full),
        body: p.body,
        domain,
        status: p.status as RuleStatus,
        ...(typeof untested === "string" ? { untested } : {}),
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
        docs.push({ kind: "decision", ...common, status: p.status as DecisionStatus, ...(typeof supersedes === "string" ? { supersedes } : {}) });
      } else if (type.name === "change") {
        const rules = p.meta["rules"] ?? [];
        if (!Array.isArray(rules) || rules.some((r) => typeof r !== "string")) {
          problems.push({ path, message: "`rules` must be a list of rule ids" });
          continue;
        }
        docs.push({ kind: "change", ...common, status: p.status as ChangeStatus, rules: rules as string[] });
      } else if (type.name === "note") {
        docs.push({ kind: "note", ...common });
      } else {
        docs.push({ kind: "extra", type: type.name, ...common, status: p.status as string | undefined });
      }
    }
  }
  return { corpus: { docs, domains, types }, problems };
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
