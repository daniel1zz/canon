import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocFile, parseReadme } from "./docfile.ts";
import { parseLinks, parsePasses } from "./behaviour.ts";
import { changeLinks } from "../changes/links.ts";
import { NO_LAYOUT, type ChangeStatus, type Corpus, type CodeList, type Advances, type DecisionStatus, type Doc, type FeatureStatus, type Domain, type Layout, type QualityJudge, type QualityStatus, type ReleaseStatus, type RuleStatus } from "./model.ts";
import { BUILTIN_TYPES, type DocType } from "./types.ts";

/** A chore identity (D-100), the value of a light change's `chore` (BR-2458). */
const CHORE_IDENTITY = /^chore-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const releasePrefix = types.find((t) => t.name === "release")?.prefix ?? "R";
  const featurePrefix = types.find((t) => t.name === "feature")?.prefix ?? "F";
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
      const business = p.meta["business"];
      if (business !== undefined && (typeof business !== "string" || business.trim() === "")) {
        problems.push({ path: rel(full), message: "`business` must name a business its domain README lists" });
        continue;
      }
      const lists = codeLists(p.meta["lists"]);
      if (typeof lists === "string") {
        problems.push({ path: rel(full), message: lists });
        continue;
      }
      const tags = releaseTags(p.meta, releasePrefix, featurePrefix);
      if (typeof tags === "string") {
        problems.push({ path: rel(full), message: tags });
        continue;
      }
      const links = parseLinks(p.meta["links"]);
      if (typeof links === "string") {
        problems.push({ path: rel(full), message: links });
        continue;
      }
      // reason: a declared future change is part of the planned rule only; once active it is plain text again (BR-2496, D-127)
      const willAmend = p.meta["will_amend"];
      if (willAmend !== undefined && (!Array.isArray(willAmend) || willAmend.length === 0 || willAmend.some((x) => typeof x !== "string" || x.trim() === ""))) {
        problems.push({ path: rel(full), message: "`will_amend` must be a non-empty list of the active rule ids this rule will change when it becomes active (BR-2496)" });
        continue;
      }
      if (willAmend !== undefined && p.status !== "planned") {
        problems.push({ path: rel(full), message: "`will_amend` is only for a planned rule: remove it in the change that makes the rule active, which also changes the rules it names (BR-2496)" });
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
        ...(typeof business === "string" ? { business: business.trim() } : {}),
        ...(lists.length > 0 ? { lists } : {}),
        ...(tags.release !== undefined ? { release: tags.release } : {}),
        ...(tags.changedIn.length > 0 ? { changedIn: tags.changedIn } : {}),
        ...(tags.feature !== undefined ? { feature: tags.feature } : {}),
        ...(Object.keys(links).length > 0 ? { links } : {}),
        ...(willAmend !== undefined ? { willAmend: (willAmend as string[]).map((x) => x.trim()) } : {}),
      });
    }
    for (const sub of listDirs(dir)) walk(`${domain}/${sub}`, domain);
  };
  for (const domain of listDirs(rulesDir)) walk(domain, undefined);

  let qualityReadme: { path: string; text: string } | undefined;
  for (const type of types) {
    if (type.name === "rule") continue;
    const dir = join(base, type.dir);
    const numbered = new RegExp(`^${type.prefix}-\\d+(-[a-z0-9-]+)?\\.md$`);
    for (const file of listFiles(dir)) {
      // reason: the quality directory's README is the aspect list, not a quality standard (BR-2552, BR-2556)
      if (type.name === "quality" && file === "README.md") {
        const full = join(dir, file);
        qualityReadme = { path: rel(full), text: readFileSync(full, "utf8") };
        continue;
      }
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
        const supersedes = supersedesIds(p.meta["supersedes"]);
        if (!supersedes) {
          problems.push({ path, message: "`supersedes` must be a decision id or a list of decision ids" });
          continue;
        }
        const amends = p.meta["amends"] ?? [];
        if (!Array.isArray(amends) || amends.some((a) => typeof a !== "string")) {
          problems.push({ path, message: "`amends` must be a list of decision ids" });
          continue;
        }
        const links = parseLinks(p.meta["links"]);
        if (typeof links === "string") {
          problems.push({ path, message: links });
          continue;
        }
        const revisedBecause = typeof p.meta["revised_because"] === "string" ? (p.meta["revised_because"] as string).trim() : undefined;
        docs.push({ kind: "decision", ...common, status: p.status as DecisionStatus, supersedes, amends: amends as string[], ...(revisedBecause ? { revisedBecause } : {}), ...(Object.keys(links).length > 0 ? { links } : {}) });
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
        // reason: `plan` and `steps` are left from the plans D-148 removed: never read, whatever they hold (BR-2594)
        // reason: whether the release or feature exists, and whether the links contradict, is canon check's to say (BR-2561)
        const links = changeLinks(p.meta, { change: type.prefix, release: releasePrefix, feature: featurePrefix });
        if (typeof links === "string") {
          problems.push({ path, message: links });
          continue;
        }
        const answers = p.meta["owner_answers"];
        if (answers !== undefined && (!Array.isArray(answers) || answers.length === 0 || answers.some((a) => typeof a !== "number" || !Number.isInteger(a) || a <= 0))) {
          problems.push({ path, message: "`owner_answers` must be a non-empty list of canon human question numbers, such as [51] (BR-2510)" });
          continue;
        }
        const chore = p.meta["chore"];
        if (chore !== undefined && (typeof chore !== "string" || !CHORE_IDENTITY.test(chore))) {
          problems.push({ path, message: "`chore` must be the chore identity of the light change's work, such as chore-<UUID>; canon writes it when the chore lands (BR-2458)" });
          continue;
        }
        const advances = advancesOf(p.meta["advances"], releasePrefix, featurePrefix);
        if (typeof advances === "string") {
          problems.push({ path, message: advances });
          continue;
        }
        docs.push({ kind: "change", ...common, status: p.status as ChangeStatus, rules: rules as string[], passes, ...links, ...(answers !== undefined ? { ownerAnswers: answers as number[] } : {}), ...(chore !== undefined ? { chore: (chore as string).toLowerCase() } : {}), ...(advances !== undefined ? { advances } : {}) });
      } else if (type.name === "release") {
        const shippedAt = p.meta["shipped_at"];
        const shipped = p.status === "shipped";
        // reason: a shipped release names the main commit it was, a release not shipped names none: `shipped_at` is how the freeze is checked (D-61)
        if (shipped && !(typeof shippedAt === "string" && /^[0-9a-f]{40}$/.test(shippedAt))) {
          problems.push({ path, message: "a shipped release needs `shipped_at`: the full 40-character commit id `canon release ship` wrote (D-61)" });
          continue;
        }
        if (!shipped && shippedAt !== undefined) {
          problems.push({ path, message: `\`shipped_at\` is only for a shipped release; ${id} is ${String(p.status)} (D-61)` });
          continue;
        }
        const features = p.meta["features"] ?? [];
        if (!Array.isArray(features) || features.some((f) => typeof f !== "string" || !new RegExp(`^${featurePrefix}-\\d+$`).test(f))) {
          problems.push({ path, message: `\`features\` must be a list of feature ids such as [${featurePrefix}-1] (BR-2512)` });
          continue;
        }
        const mergedInto = p.meta["merged_into"];
        if (mergedInto !== undefined && (typeof mergedInto !== "string" || !new RegExp(`^${releasePrefix}-\\d+$`).test(mergedInto) || mergedInto === id || p.status !== "dropped")) {
          problems.push({ path, message: `\`merged_into\` is one other release id, only on a dropped release (BR-2512)` });
          continue;
        }
        docs.push({ kind: "release", ...common, status: p.status as ReleaseStatus, ...(shipped ? { shippedAt: shippedAt as string } : {}), features: features as string[], ...(mergedInto !== undefined ? { mergedInto: mergedInto as string } : {}) });
      } else if (type.name === "feature") {
        docs.push({ kind: "feature", ...common, status: p.status as FeatureStatus });
      } else if (type.name === "quality") {
        const q = qualityFields(p.meta, p.status as string);
        if (typeof q === "string") {
          problems.push({ path, message: q });
          continue;
        }
        docs.push({ kind: "quality", ...common, status: p.status as QualityStatus, ...q });
      } else if (type.name === "note") {
        docs.push({ kind: "note", ...common });
      } else {
        docs.push({ kind: "extra", type: type.name, ...common, status: p.status as string | undefined });
      }
    }
  }
  return { corpus: { docs, domains, types, layout: { codeRoot, shared }, numbers, ...(qualityReadme ? { qualityReadme } : {}) }, problems };
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

/** A rule's `release` and `changed_in` front matter (D-61), or the problem with it; whether the ids name releases is `canon check`'s to say. */
function releaseTags(meta: Record<string, unknown>, prefix: string, featurePrefix: string): { release: string | undefined; changedIn: string[]; feature: string | undefined } | string {
  const id = new RegExp(`^${prefix}-\\d+$`);
  const release = meta["release"];
  const changed = meta["changed_in"];
  const feature = meta["feature"];
  if (release !== undefined && (typeof release !== "string" || !id.test(release))) return `\`release\` must be one release id such as ${prefix}-1 (D-61)`;
  if (feature !== undefined && (typeof feature !== "string" || !new RegExp(`^${featurePrefix}-\\d+$`).test(feature))) return `\`feature\` must be one feature id such as ${featurePrefix}-1 (BR-2509)`;
  if (feature !== undefined && release !== undefined) return "a rule names its release through `release` or through `feature`, not both: the feature's release is the one listing it (BR-2509)";
  if (changed !== undefined && (!Array.isArray(changed) || changed.length === 0 || changed.some((c) => typeof c !== "string" || !id.test(c)))) {
    return `\`changed_in\` must be a non-empty list of release ids such as [${prefix}-2] (D-61)`;
  }
  if (changed !== undefined && release === undefined && feature === undefined) return "`changed_in` needs `release`: a rule that belongs to no release has no later release to change it (D-61)";
  // reason: a release is changed only by a later one: R-2 may change R-1's rule, R-1 may not change its own (D-61, BR-2322)
  const num = (v: string) => Number(v.split("-")[1]);
  const early = release !== undefined ? (changed as string[] | undefined)?.find((c) => num(c) <= num(release)) : undefined;
  if (early !== undefined) return `\`changed_in\` names ${early}, which is not later than \`release\` ${release as string}: a release is changed only by a later one (D-61)`;
  return { release: release as string | undefined, changedIn: (changed as string[] | undefined) ?? [], feature: feature as string | undefined };
}

const JUDGES: readonly string[] = ["test", "agent", "owner"] satisfies readonly QualityJudge[];

/** A quality standard's own front matter (BR-2552), or the problem with it; whether aspect and covers name anything is `canon check`'s to say (BR-2555). */
function qualityFields(meta: Record<string, unknown>, status: string): { aspect: string; judge: QualityJudge; covers: string[]; retiredReason?: string } | string {
  const aspect = meta["aspect"];
  if (typeof aspect !== "string" || aspect.trim() === "") return "`aspect` must name the aspect this standard belongs to, as canon/quality/README.md lists it (BR-2552)";
  const judge = meta["judge"];
  if (typeof judge !== "string" || !JUDGES.includes(judge)) return `\`judge\` must be one of ${JUDGES.join(", ")}: who judges this standard (BR-2552)`;
  const covers = meta["covers"];
  const badPath = (c: string) => c.startsWith("/") || c.split("/").includes("..");
  if (!Array.isArray(covers) || covers.length === 0 || covers.some((c) => typeof c !== "string" || c.trim() === "" || badPath(c.trim()))) {
    return "`covers` must be a non-empty list of domains or repository-relative paths (`.` for the whole repository; no absolute path, no `..`) (BR-2552)";
  }
  const reason = meta["retired_reason"];
  const hasReason = typeof reason === "string" && reason.trim() !== "";
  if (status === "retired" && !hasReason) return "a retired standard needs `retired_reason`: why it no longer applies (BR-2552)";
  if (status !== "retired" && reason !== undefined) return `\`retired_reason\` is only for a retired standard; this one is ${status} (BR-2552)`;
  return { aspect: aspect.trim(), judge: judge as QualityJudge, covers: (covers as string[]).map((c) => c.trim()), ...(hasReason ? { retiredReason: (reason as string).trim() } : {}) };
}

/** A change's `advances` (BR-2517): undefined when absent, the problem with it as a string. */
function advancesOf(v: unknown, releasePrefix: string, featurePrefix: string): Advances | undefined | string {
  if (v === undefined) return undefined;
  const bad = `\`advances\` is a non-empty list of success criteria such as [${releasePrefix}-5/S1, ${featurePrefix}-3/S2], or "none: <reason>" (BR-2517)`;
  if (typeof v === "string") {
    const m = /^none:\s*(.*)$/s.exec(v.trim());
    return m && m[1]!.trim() !== "" ? { kind: "none", reason: m[1]!.trim() } : bad;
  }
  const ref = new RegExp(`^(?:${releasePrefix}|${featurePrefix})-\\d+/S\\d+$`);
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !ref.test(x))) return bad;
  return { kind: "criteria", refs: v as string[] };
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

/** The decision ids a front matter `supersedes` names: one id, or a list of ids like `amends`; undefined for any other shape (BR-2027). */
export function supersedesIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some((v) => typeof v !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(v))) return undefined;
  return list as string[];
}
