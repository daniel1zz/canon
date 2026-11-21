import { err, ok, type Result } from "../../kernel/result.ts";
import { businessesOf } from "../domains/business.ts";
import { cliValue, fieldProblem, shapeText, type FieldDeclaration } from "./fields.ts";
import type { Advances, Corpus } from "./model.ts";
import { JUDGES, REVISION_REASONS, type DocType } from "./types.ts";

/**
 * The fields a session states when it creates a document (BR-2620, BR-2623, D-159): the values canon's own reader takes
 * for the built-in ones, and the check every creating command runs before it allocates an id.
 */

const NONE = /^none:\s*(.*)$/s;

/** `none: <reason>` with a non-empty reason → the reason; anything else → undefined. */
function noneReason(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = NONE.exec(v.trim());
  return m && m[1]!.trim() !== "" ? m[1]!.trim() : undefined;
}

const isNone = (v: unknown): boolean => typeof v === "string" && v.trim().startsWith("none:");

/** A change's `owner_gate` (BR-2615, BR-2623): the text when it gates; undefined when absent or `none: <reason>`; the problem as `{ problem }`. */
export function ownerGateOf(v: unknown): { gate: string | undefined } | { problem: string } {
  if (v === undefined) return { gate: undefined };
  const bad = { problem: "`owner_gate` must be a non-empty text saying what the owner approves, such as \"研究站剧情设计稿\", or \"none: <reason>\" (BR-2615, BR-2623)" };
  if (typeof v !== "string" || v.trim() === "") return bad;
  // reason: `none: <reason>` states that no approval is needed; it is no gate (BR-2623, D-159)
  if (isNone(v)) return noneReason(v) !== undefined ? { gate: undefined } : bad;
  return { gate: v.trim() };
}

/** A change's `advances` (BR-2517): undefined when absent, the problem with it as a string. */
export function advancesOf(v: unknown, releasePrefix: string, featurePrefix: string): Advances | undefined | string {
  if (v === undefined) return undefined;
  const bad = `\`advances\` is a non-empty list of success criteria such as [${releasePrefix}-5/S1, ${featurePrefix}-3/S2], or "none: <reason>" (BR-2517)`;
  if (typeof v === "string") {
    const reason = noneReason(v);
    return reason !== undefined ? { kind: "none", reason } : bad;
  }
  const ref = new RegExp(`^(?:${releasePrefix}|${featurePrefix})-\\d+/S\\d+$`);
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !ref.test(x))) return bad;
  return { kind: "criteria", refs: v as string[] };
}

/** A decision's `amends` (BR-2623): the ids it amends ([] when absent or `none: <reason>`), or the problem. */
export function amendsOf(v: unknown): string[] | { problem: string } {
  if (v === undefined || noneReason(v) !== undefined) return [];
  if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) return { problem: "`amends` must be a list of decision ids, or \"none: <reason>\" (BR-2623)" };
  return v as string[];
}

/** A release's `features` (BR-2512, BR-2623): its feature ids ([] when absent or `none: <reason>`), or the problem. */
export function featuresOf(v: unknown, featurePrefix: string): string[] | { problem: string } {
  if (v === undefined || noneReason(v) !== undefined) return [];
  const id = new RegExp(`^${featurePrefix}-\\d+$`);
  if (!Array.isArray(v) || v.some((f) => typeof f !== "string" || !id.test(f))) return { problem: `\`features\` must be a list of feature ids such as [${featurePrefix}-1], or "none: <reason>" (BR-2512, BR-2623)` };
  return v as string[];
}

/** Where a document is being created: the corpus it joins, and a rule's domain. */
export interface StatedContext {
  readonly corpus: Corpus;
  readonly domain?: string;
}

const prefixOf = (corpus: Corpus, name: string, fallback: string): string => corpus.types.find((t) => t.name === name)?.prefix ?? fallback;

/** The command-line flag of a built-in stated field (BR-2623): `owner_gate` → `--owner-gate`. */
export const flagOf = (field: string): string => `--${field.replace(/_/g, "-")}`;

/** The built-in fields that have a flag of their own on the creating command (BR-2623); other fields take `--set`. */
export const BUILTIN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  change: ["owner_gate", "advances"],
  rule: ["business"],
  decision: ["amends", "revised_because"],
  release: ["features"],
  quality: ["aspect", "judge", "covers"],
};

/**
 * Whether a decision's `amends` or `supersedes` names another decision that exists (BR-2623, BR-2492): only then is
 * `revised_because` due. One that names only itself, a missing id or a document that is no decision revises nothing.
 */
export function revisesDecision(corpus: Corpus, amends: unknown, supersedes: unknown, self?: string): boolean {
  const decisions = new Set(corpus.docs.filter((d) => d.kind === "decision").map((d) => d.id));
  const ids = (v: unknown): string[] => (typeof v === "string" ? (isNone(v) ? [] : v.split(/[,，、]/)) : Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.trim());
  return [...ids(amends), ...ids(supersedes)].some((id) => id !== self && decisions.has(id));
}

/** The fields of `type` stated at creation (BR-2620): its `due: create` ones, and `revised_because` when the decision revises another (BR-2623). */
export function dueFields(type: DocType, revising: boolean): FieldDeclaration[] {
  return type.fields.filter((f) => f.due === "create" || (type.name === "decision" && f.name === "revised_because" && revising));
}

/** What the value of `f` may be, said in a refusal without the flag (BR-2624). */
export function allowedText(type: DocType, f: FieldDeclaration, ctx: StatedContext): string {
  switch (`${type.name}.${f.name}`) {
    case "change.owner_gate": return "a text saying what the owner approves, or \"none: <reason>\"";
    case "change.advances": return `success criteria such as ${prefixOf(ctx.corpus, "release", "R")}-5/S1, comma separated, or "none: <reason>"`;
    case "rule.business": {
      const domain = ctx.domain === undefined ? undefined : ctx.corpus.domains.find((d) => d.name === ctx.domain);
      const names = domain ? businessesOf(domain).map((b) => b.name) : [];
      return names.length > 0 ? `one of the businesses ${ctx.domain}'s README lists: ${names.join(", ")}` : `a business ${ctx.domain ?? "its domain"}'s README lists (it lists none yet: write it under ## 业务 first)`;
    }
    case "decision.amends": return "decision ids, comma separated, or \"none: <reason>\"";
    case "decision.revised_because": return `one of ${REVISION_REASONS.join(", ")} (BR-2492)`;
    case "release.features": return `feature ids such as ${prefixOf(ctx.corpus, "feature", "F")}-1, comma separated, or "none: <reason>"`;
    case "quality.covers": return "domains or repository paths, comma separated";
    default: return shapeText(f);
  }
}

/** What the value of `f` is allowed to be, and how to give it, said in a refusal (BR-2620). */
function howToGive(type: DocType, f: FieldDeclaration, ctx: StatedContext): string {
  const flag = BUILTIN_FLAGS[type.name]?.includes(f.name) ? flagOf(f.name) : `--set ${f.name}=`;
  const sep = flag.startsWith("--set") ? "" : " ";
  const example = (v: string) => `${flag}${sep}"${v}"`;
  switch (`${type.name}.${f.name}`) {
    case "change.owner_gate":
      return `${example("<what the owner approves>")} or ${example("none: <reason>")}`;
    case "change.advances":
      return `${example(`${prefixOf(ctx.corpus, "release", "R")}-<n>/S<n>, …`)} (the success criteria it advances) or ${example("none: <reason>")}`;
    case "rule.business": {
      const domain = ctx.domain === undefined ? undefined : ctx.corpus.domains.find((d) => d.name === ctx.domain);
      const names = domain ? businessesOf(domain).map((b) => b.name) : [];
      return names.length > 0
        ? `${example("<business>")}, one of the businesses ${ctx.domain}'s README lists: ${names.join(", ")}`
        : `${example("<business>")}; ${ctx.domain ?? "the domain"}'s README lists no business yet: write it under its ## 业务 first (BR-2430)`;
    }
    case "decision.amends":
      return `${example("D-<n>, …")} (the decisions it amends) or ${example("none: <reason>")}`;
    case "decision.revised_because":
      return `${example("<reason>")}, one of ${REVISION_REASONS.join(", ")} (BR-2492)`;
    case "release.features":
      return `${example(`${prefixOf(ctx.corpus, "feature", "F")}-<n>, …`)} or ${example("none: <reason>")}`;
    case "quality.judge":
      return `${example("<judge>")}, one of ${JUDGES.join(", ")}`;
    default:
      return `${example("<value>")}: ${shapeText(f)}`;
  }
}

/** Why `value` does not fit `f` for this type, or undefined (BR-2620, BR-2622, BR-2623). */
export function statedProblem(type: DocType, f: FieldDeclaration, value: unknown, ctx: StatedContext): string | undefined {
  if (!f.own) return fieldProblem(f, value);
  switch (`${type.name}.${f.name}`) {
    case "change.owner_gate": {
      const g = ownerGateOf(value);
      return "problem" in g ? g.problem : undefined;
    }
    case "change.advances": {
      const a = advancesOf(value, prefixOf(ctx.corpus, "release", "R"), prefixOf(ctx.corpus, "feature", "F"));
      return typeof a === "string" ? a : undefined;
    }
    case "rule.business": {
      if (typeof value !== "string" || value.trim() === "") return "`business` must be the name of one of its domain's businesses (BR-2430)";
      const domain = ctx.domain === undefined ? undefined : ctx.corpus.domains.find((d) => d.name === ctx.domain);
      if (!domain) return undefined;
      return businessesOf(domain).some((b) => b.name === value.trim()) ? undefined : `\`business\` is ${JSON.stringify(value.trim())}, which ${domain.name}'s README does not list (BR-2430)`;
    }
    case "decision.amends": {
      if (isNone(value)) return noneReason(value) !== undefined ? undefined : "`amends`: \"none:\" needs a reason after it";
      const prefix = prefixOf(ctx.corpus, "decision", "D");
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && new RegExp(`^${prefix}-\\d+$`).test(v.trim()))
        ? undefined
        : `\`amends\` is ${JSON.stringify(value)}, not a list of decision ids such as [${prefix}-3], or "none: <reason>"`;
    }
    case "release.features": {
      if (isNone(value)) return noneReason(value) !== undefined ? undefined : "`features`: \"none:\" needs a reason after it";
      const r = featuresOf(value, prefixOf(ctx.corpus, "feature", "F"));
      if ("problem" in r) return r.problem;
      return r.length > 0 ? undefined : "`features` must name at least one feature, or be \"none: <reason>\"";
    }
    case "quality.covers":
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim() !== "") ? undefined : "`covers` must list the domains or repository paths it covers (BR-2553)";
    default:
      return fieldProblem(f, value);
  }
}

/** The value a command-line string gives `f` (BR-2620, BR-2621): lists split on , ， or 、 unless it is `none: …`. */
export function valueOf(f: FieldDeclaration, raw: string): unknown {
  // reason: `covers` takes paths, not document ids, but is given and written as a list like one (BR-2553)
  return cliValue(f.type === "ids" || f.name === "covers" ? { ...f, type: "ids" } : f, raw);
}

/**
 * BR-2620: the fields a creating command was given (`--set field=value`, written several times, and the built-in flags
 * in `flags`), checked against `type`'s declarations before any id is allocated. Every `due: create` field must be given;
 * every given field must be declared, given once and fit its declaration. `revised_because` is due when `amends` or
 * `supersedes` names a decision (BR-2623). A refusal lists every problem at once.
 */
export function statedFields(type: DocType, set: readonly string[], flags: Readonly<Record<string, string | undefined>>, ctx: StatedContext, supersedes?: string): Result<Record<string, unknown>> {
  const problems: string[] = [];
  const given = new Map<string, string>();
  const declared = new Map(type.fields.map((f) => [f.name, f]));
  for (const pair of set) {
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair.trim() : pair.slice(0, eq).trim();
    if (eq < 0) problems.push(`--set ${pair}: write --set <field>=<value>`);
    else if (!declared.has(name)) problems.push(`--set ${name}: ${type.name} declares no field ${name}${type.fields.length > 0 ? ` (declared: ${type.fields.map((f) => f.name).join(", ")})` : ""}`);
    else if (given.has(name)) problems.push(`${name} is given twice`);
    else given.set(name, pair.slice(eq + 1));
  }
  for (const [name, raw] of Object.entries(flags)) {
    if (raw === undefined) continue;
    if (given.has(name)) problems.push(`${name} is given twice (${flagOf(name)} and --set)`);
    else given.set(name, raw);
  }
  const out: Record<string, unknown> = {};
  for (const [name, raw] of given) {
    const f = declared.get(name);
    if (!f) continue;
    const value = valueOf(f, raw);
    const problem = statedProblem(type, f, value, ctx);
    if (problem) problems.push(`${problem}; give ${howToGive(type, f, ctx)}`);
    else out[name] = value;
  }
  const revising = type.name === "decision" && revisesDecision(ctx.corpus, out["amends"], supersedes);
  for (const f of dueFields(type, revising)) if (!given.has(f.name)) problems.push(`missing ${f.name}: give ${howToGive(type, f, ctx)}`);
  return problems.length === 0 ? ok(out) : err("invalid", `${type.name} not created, no id allocated (BR-2620):\n${problems.map((p) => `  ${p}`).join("\n")}`);
}

const FLAG_HELP: Readonly<Record<string, string>> = {
  owner_gate: "What the owner must approve before it finishes, or \"none: <reason>\" (BR-2615, BR-2623)",
  advances: "The success criteria it advances (R-<n>/S<n>, comma separated), or \"none: <reason>\" (BR-2517, BR-2623)",
  business: "The business of its domain it belongs to, as the domain README lists it (BR-2430, BR-2623)",
  amends: "The decisions it amends (comma separated), or \"none: <reason>\" (BR-2623)",
  revised_because: `Why it amends or supersedes a decision: ${REVISION_REASONS.join(", ")} (BR-2492)`,
  features: "The features it ships (comma separated), or \"none: <reason>\" (BR-2623)",
};

/** The creating command's arguments for the fields (BR-2620): `--set`, and the built-in flags of `typeName` not already defined. */
export function statedArgs(typeName: string): Record<string, { type: "string"; description: string }> {
  const out: Record<string, { type: "string"; description: string }> = {
    set: { type: "string", description: "A declared field's value, <field>=<value>; write it once per field (BR-2620)" },
  };
  for (const f of BUILTIN_FLAGS[typeName] ?? []) {
    const help = FLAG_HELP[f];
    if (help) out[flagOf(f).slice(2)] = { type: "string", description: help };
  }
  return out;
}

/** The `--set` values and the built-in flags of `typeName` from parsed command-line arguments (BR-2620). */
export function statedInput(typeName: string, args: Readonly<Record<string, unknown>>): { set: string[]; flags: Record<string, string | undefined> } {
  const raw = args["set"];
  const set = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
  const flags: Record<string, string | undefined> = {};
  for (const f of BUILTIN_FLAGS[typeName] ?? []) {
    const v = args[flagOf(f).slice(2)];
    if (v !== undefined) flags[f] = Array.isArray(v) ? String(v[v.length - 1]) : String(v);
  }
  return { set, flags };
}

/** `statedFields` for a type of `corpus` from parsed command-line arguments (BR-2620). */
export function statedFor(corpus: Corpus, typeName: string, args: Readonly<Record<string, unknown>>, domain?: string, supersedes?: string): Result<Record<string, unknown>> {
  const type = corpus.types.find((t) => t.name === typeName);
  if (!type) return err("not_found", `no document type ${typeName}`);
  const given = statedInput(typeName, args);
  return statedFields(type, given.set, given.flags, { corpus, ...(domain !== undefined ? { domain } : {}) }, supersedes);
}
