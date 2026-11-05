import { existsSync } from "node:fs";
import { join } from "node:path";
import { hooksGuide } from "../work/hooks/guide.ts";
import { documentGuide } from "../knowledge/documents/guide.ts";
import { queryGuide } from "../knowledge/query/guide.ts";
import { reviewGuide } from "../knowledge/review/guide.ts";
import { dropGuide } from "../work/drop/guide.ts";
import { humanGuide } from "../work/humans/guide.ts";
import { issueGuide } from "../work/issues/guide.ts";
import { landGuide } from "../work/land/guide.ts";
import { sessionGuide } from "../work/session/guide.ts";
import { snapshotGuide } from "../work/snapshots/guide.ts";
import { verifyGuide } from "../work/verify/guide.ts";

/** One line of the workflow guide, from the domain it is about; `rank` is its place in the guide (lower first). */
export interface GuideLine {
  readonly rank: number;
  readonly text: string;
}

const HEADER = `canon keeps this project's shared memory in canon/: rules (rules/<domain>/BR-n.md, how the product must behave), decisions (D-n, why), changes (C-n, the work). How to work here:`;

/**
 * The guide's lines in rank order under the header, each as a "- " item. Every domain writes its own lines in guide.ts
 * in its own directory, so editing or adding one never touches this file; it changes only when a domain is added (C-133).
 * Two lines with the same rank are a bug in canon and throw.
 */
export function assembleGuide(header: string, domains: readonly (readonly GuideLine[])[]): string {
  const lines = domains.flat();
  const ranks = new Set<number>();
  for (const l of lines) {
    if (ranks.has(l.rank)) throw new Error(`two workflow guide lines have rank ${l.rank}`);
    ranks.add(l.rank);
  }
  return [header, ...[...lines].sort((a, b) => a.rank - b.rank).map((l) => `- ${l.text}`)].join("\n");
}

/**
 * How to work in a canon project, printed by `canon brief` at every session start (BR-2090, D-10).
 * It ships with the binary instead of being installed as a file, so it always matches the canon that runs.
 */
const DOMAIN_LINES = [hooksGuide, documentGuide, queryGuide, reviewGuide, dropGuide, humanGuide, issueGuide, landGuide, sessionGuide, snapshotGuide, verifyGuide] as const;

/** The first line, only in a project that has an architecture overview (BR-2090, D-65); without one BR-2085's update notice stands in for it. */
const OVERVIEW_LINE: GuideLine = { rank: 0, text: "Read canon/architecture.md first." };

export const WORKFLOW_GUIDE = assembleGuide(HEADER, DOMAIN_LINES);

/** The guide as `canon brief` prints it in the project at `root`: with the overview line when `canon/architecture.md` is there. */
export function guideFor(root: string): string {
  return existsSync(join(root, "canon/architecture.md")) ? assembleGuide(HEADER, [[OVERVIEW_LINE], ...DOMAIN_LINES]) : WORKFLOW_GUIDE;
}
