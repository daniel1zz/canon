/**
 * A change's links (D-148, BR-2561): the release or feature it belongs to, the GitHub issues it fixes, the changes it
 * depends on, and on a dropped change the change that did its work instead. All live in the change's own front matter,
 * written by commands (BR-2562, BR-2563). The shape is read here, for the corpus and for change files read off a
 * branch alike; whether the release or feature exists and whether dependencies form a cycle is `canon check`'s to say.
 */

export interface ChangeLinks {
  readonly release?: string;
  readonly feature?: string;
  readonly issues?: readonly number[];
  readonly dependsOn?: readonly string[];
  readonly doneBy?: string;
  /** On a done change closed by `canon change close`: the commit on main that carried its work (BR-2573). */
  readonly landedIn?: string;
}

/** The front-matter keys of the links (BR-2561); reserved so a declared type cannot reuse them. */
export const LINK_KEYS = ["release", "feature", "issues", "depends_on", "done_by", "landed_in"] as const;

export interface Prefixes {
  readonly change: string;
  readonly release: string;
  readonly feature: string;
}

/** A commit id as `landed_in` takes it (BR-2573). */
export const COMMIT = /^[0-9a-f]{7,40}$/;

const idOf = (prefix: string) => new RegExp(`^${prefix}-\\d+$`);

/** A success criterion a change may depend on: `R-n/S<k>` or `F-n/S<k>` (BR-2504, BR-2561). */
export const criterionRef = (p: Prefixes) => new RegExp(`^(?:${p.release}|${p.feature})-\\d+/S\\d+$`);

/** Whether a `depends_on` entry names a success criterion rather than a change (BR-2564). */
export const isCriterionRef = (ref: string): boolean => ref.includes("/");

/** The links in `meta`, `{}` when it has none, or the problem with the first malformed key (BR-2561). */
export function changeLinks(meta: Record<string, unknown>, p: Prefixes): ChangeLinks | string {
  const out: { -readonly [K in keyof ChangeLinks]: ChangeLinks[K] } = {};
  const one = (key: string, prefix: string, what: string): string | undefined => {
    const v = meta[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !idOf(prefix).test(v)) return `\`${key}\` must be one ${what} id such as ${prefix}-1 (BR-2561)`;
    return undefined;
  };
  for (const [key, prefix, what] of [["release", p.release, "release"], ["feature", p.feature, "feature"], ["done_by", p.change, "change"]] as const) {
    const bad = one(key, prefix, what);
    if (bad) return bad;
  }
  if (meta["release"] !== undefined) out.release = meta["release"] as string;
  if (meta["feature"] !== undefined) out.feature = meta["feature"] as string;
  if (meta["done_by"] !== undefined) out.doneBy = meta["done_by"] as string;
  const landed = meta["landed_in"];
  if (landed !== undefined) {
    if (typeof landed !== "string" || !COMMIT.test(landed)) return "`landed_in` must be a commit id of 7 to 40 hex digits (BR-2573)";
    out.landedIn = landed;
  }
  const issues = meta["issues"];
  if (issues !== undefined) {
    if (!Array.isArray(issues) || issues.some((i) => typeof i !== "number" || !Number.isInteger(i) || i <= 0)) return "`issues` must be a list of GitHub issue numbers, such as [12, 40] (BR-2561)";
    out.issues = issues as number[];
  }
  const deps = meta["depends_on"];
  if (deps !== undefined) {
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string" || !(idOf(p.change).test(d) || criterionRef(p).test(d)))) return `\`depends_on\` must be a list of change ids or success criteria, such as [${p.change}-1, ${p.release}-1/S2] (BR-2561)`;
    out.dependsOn = deps as string[];
  }
  return out;
}

/** The front matter the links are written as: every key, undefined where a link is absent so a patch removes it. */
export function linkMeta(l: ChangeLinks): Record<string, unknown> {
  return {
    release: l.release,
    feature: l.feature,
    issues: l.issues && l.issues.length > 0 ? [...l.issues] : undefined,
    depends_on: l.dependsOn && l.dependsOn.length > 0 ? [...l.dependsOn] : undefined,
    done_by: l.doneBy,
    landed_in: l.landedIn,
  };
}

/** `--issue 12,#40` as numbers, or the value that is not one (BR-2562). */
export function issueArg(values: readonly string[]): number[] | string {
  const out: number[] = [];
  for (const v of values) {
    const s = v.replace(/^#/, "");
    if (!/^[1-9]\d*$/.test(s)) return v;
    out.push(Number(s));
  }
  return out;
}

/** `--depends C-3,r-2/s1` as change ids and success criteria, or the value that is neither (BR-2562). */
export function dependsArg(values: readonly string[], p: Prefixes): string[] | string {
  const out: string[] = [];
  for (const v of values) {
    const id = v.trim().toUpperCase();
    if (!idOf(p.change).test(id) && !criterionRef(p).test(id)) return v;
    out.push(id);
  }
  return out;
}
