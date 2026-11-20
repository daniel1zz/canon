import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../check/check.ts";
import type { Corpus } from "../documents/model.ts";
import { coverage, DECISION_LABEL } from "./aspects.ts";

/**
 * `canon check`'s findings on quality standards and the aspect list (BR-2555, BR-2556): the list's format, each standard
 * in force naming a listed aspect and existing domains or paths, and no aspect both set aside by the owner and covered.
 */
export function qualityFindings(root: string, corpus: Corpus): Finding[] {
  const out: Finding[] = [];
  const c = coverage(corpus);
  const { list } = c;
  for (const p of list.problems) out.push({ path: p.line !== undefined ? `${list.path}:${p.line}` : list.path, rule: "file-invalid", message: `${list.path}${p.line !== undefined ? ` line ${p.line}` : ""}: ${p.message}` });
  const domains = new Set(corpus.domains.map((d) => d.name));
  for (const q of c.current) {
    if (c.unlisted.includes(q)) {
      out.push({ path: q.path, rule: "ref-dangling", message: `${q.id} \`aspect\` is ${q.aspect}, which ${list.path} does not list: add \`- **${q.aspect}**\` under ${"`## 方面`"} there (BR-2555)` });
    }
    // reason: a covered entry is a domain when one has that name, else a path in the repository; `.` is the whole repository (BR-2552, BR-2555)
    for (const entry of q.covers) {
      if (!domains.has(entry) && !existsSync(join(root, entry))) out.push({ path: q.path, rule: "ref-dangling", message: `${q.id} \`covers\` names ${entry}, which is neither a domain nor a file or directory in the repository (BR-2555)` });
    }
  }
  for (const v of c.views) {
    if (v.aspect.decision === undefined) continue;
    const standards = c.current.filter((q) => q.aspect === v.aspect.name);
    if (standards.length === 0) continue;
    out.push({
      path: `${list.path}:${v.aspect.line}`,
      rule: "quality-aspect",
      message: `aspect ${v.aspect.name} is marked ${DECISION_LABEL[v.aspect.decision.kind]} by the owner, but ${standards.map((q) => q.id).join(", ")} belong to it: change the aspect list, or retire them (BR-2555)`,
    });
  }
  return out;
}
