import { existsSync } from "node:fs";
import { join } from "node:path";
import { documentGuide, documentTopics } from "../knowledge/documents/guide.ts";
import { queryGuide } from "../knowledge/query/guide.ts";
import { reviewGuide, reviewTopics } from "../knowledge/review/guide.ts";
import { dropGuide } from "../work/drop/guide.ts";
import { humanGuide, humanTopics } from "../work/humans/guide.ts";
import { issueGuide, issueTopics } from "../work/issues/guide.ts";
import { landGuide, landTopics } from "../work/land/guide.ts";
import { sessionGuide, sessionTopics } from "../work/session/guide.ts";
import { snapshotGuide } from "../work/snapshots/guide.ts";
import { verifyGuide, verifyTopics } from "../work/verify/guide.ts";

/** One line of the workflow guide, from the domain it is about; `rank` is its place in the guide (lower first). */
export interface GuideLine {
  readonly rank: number;
  readonly text: string;
}

/**
 * Detail the guide leaves out of every session's start: `canon guide <name>` prints it, and the guide's line names the
 * topic, so a session reads it when it reaches that moment (BR-2654, D-169). `when` is that moment, listed by `canon guide`.
 */
export interface GuideTopic {
  readonly name: string;
  readonly when: string;
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
const DOMAIN_LINES = [documentGuide, queryGuide, reviewGuide, dropGuide, humanGuide, issueGuide, landGuide, sessionGuide, snapshotGuide, verifyGuide] as const;

/** The first line, only in a project that has an architecture overview (BR-2090, D-65); without one BR-2085's update notice stands in for it. */
const OVERVIEW_LINE: GuideLine = { rank: 0, text: "Read canon/architecture.md first." };

export const WORKFLOW_GUIDE = assembleGuide(HEADER, DOMAIN_LINES);

/** The guide as `canon brief` prints it in the project at `root`: with the overview line when `canon/architecture.md` is there. */
export function guideFor(root: string): string {
  return existsSync(join(root, "canon/architecture.md")) ? assembleGuide(HEADER, [[OVERVIEW_LINE], ...DOMAIN_LINES]) : WORKFLOW_GUIDE;
}

/** Topics that belong to no domain: how a session states what it found (BR-2654). */
const GENERAL_TOPICS: readonly GuideTopic[] = [
  { name: "evidence", when: `before stating a number, "should"/"probably", "best practice", "X is faster than Y" or "usually", or any non-trivial conclusion`, text: `Check with a tool before concluding. Evidence tiers: S official > A standard > B maintainer > C leading blog > D community > E untrustworthy. The bar follows the impact: trivial needs at least C (an API, a version or a parameter needs S); medium needs S or A crossed with B or C; critical (architecture, security, performance, cryptography, authentication, cross-service) needs S plus at least 2 independent sources.

Write a non-trivial conclusion with \`**[EVIDENCE]** [Tier] <URL/tool call> — <key quote>\` and \`**[CONFIDENCE]** HIGH/MEDIUM/LOW\`. When sources conflict take the higher tier and say so. The evidence's setting must match the user's (performance: the hardware; security: the threat model).` },
];

/** Every topic, sorted by name; two with the same name are a bug in canon and throw (BR-2654). */
export const GUIDE_TOPICS: readonly GuideTopic[] = (() => {
  const all = [...GENERAL_TOPICS, documentTopics, reviewTopics, humanTopics, issueTopics, landTopics, sessionTopics, verifyTopics].flat().sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 1; i < all.length; i++) if (all[i]!.name === all[i - 1]!.name) throw new Error(`two guide topics are named ${all[i]!.name}`);
  return all;
})();
