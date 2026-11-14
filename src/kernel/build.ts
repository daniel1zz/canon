/**
 * Which canon wrote a record (BR-2475, D-116): the commit a released binary was built from, embedded at build time by
 * `bun build --define`; "dev" when canon runs from source, as tests and a checkout do.
 */
declare const CANON_BUILD: string | undefined;

export function canonBuild(): string {
  // reason: without --define the identifier is not declared at run time, so it is read through typeof (BR-2475)
  return typeof CANON_BUILD === "string" && CANON_BUILD !== "" ? CANON_BUILD : "dev";
}

/** The `bun build` arguments that embed `commit` as the build (BR-2475). */
export const buildDefine = (commit: string): string[] => ["--define", `CANON_BUILD=${JSON.stringify(commit)}`];
