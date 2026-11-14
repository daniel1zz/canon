import { git } from "../../../kernel/git.ts";

/** Which documents a finding is attached to and the text of each on main (BR-2453, BR-2479). */
const ID = /^(BR|D|R)-\d+$/;
/** The overview is not a document with an id, but an `overview` finding's fix usually lands there (BR-2453). */
export const OVERVIEW = "canon/architecture.md";

/** The file of document `doc` on `main`: a rule, decision or release by its id, a standing instruction by its path. */
export function pathOn(cwd: string, main: string, doc: string): string | undefined {
  if (!ID.test(doc)) return doc;
  const names = git(cwd, "ls-tree", "-r", "--name-only", main, "canon/");
  if (!names.ok) return undefined;
  const re = new RegExp(`/${doc}(-[^/]*)?\\.md$`);
  return names.value.split("\n").find((p) => re.test(p));
}

/** The documents a finding settles against: those it is attached to, and the overview for an `overview` finding (BR-2453). */
export function attachedDocs(docs: string, criterion: string): string[] {
  return [...(JSON.parse(docs) as string[]), ...(criterion === "overview" ? [OVERVIEW] : [])];
}

/**
 * The version of each document on `main`, as `doc=blob` lines sorted, `-` for one main does not hold: what a spurious close's
 * support or approval judged, so a later change to any of them makes it stale (BR-2479, BR-2480, #226).
 */
export function docsAt(cwd: string, main: string, docs: readonly string[]): string {
  return [...new Set(docs)]
    .sort()
    .map((d) => {
      const p = pathOn(cwd, main, d);
      const b = p ? git(cwd, "rev-parse", "--verify", "--quiet", `${main}:${p}`) : undefined;
      return `${d}=${b?.ok && b.value !== "" ? b.value : "-"}`;
    })
    .join("\n");
}
