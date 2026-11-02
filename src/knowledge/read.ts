import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocFile } from "./docfile.ts";
import type { Change, ChangeStatus, Corpus, Decision, DecisionStatus, Doc, Domain, Note, Rule, RuleStatus } from "./model.ts";

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

const RULE_FILE = /^BR-\d+\.md$/;
const NUMBERED_FILE: Record<"decision" | "change" | "note", RegExp> = {
  decision: /^D-\d+(-[a-z0-9-]+)?\.md$/,
  change: /^C-\d+(-[a-z0-9-]+)?\.md$/,
  note: /^N-\d+(-[a-z0-9-]+)?\.md$/,
};
const DIR_OF = { decision: "decisions", change: "changes", note: "notes" } as const;

const RULE_STATUS: readonly RuleStatus[] = ["active", "retired"];
const DECISION_STATUS: readonly DecisionStatus[] = ["proposed", "accepted", "superseded"];
const CHANGE_STATUS: readonly ChangeStatus[] = ["open", "done", "dropped"];

/** Reads every knowledge document under `<root>/canon`. Files that do not parse become problems, not exceptions. */
export function readCorpus(root: string): ReadResult {
  const docs: Doc[] = [];
  const domains: Domain[] = [];
  const problems: FileProblem[] = [];
  const base = join(root, CANON_DIR);
  const rel = (p: string) => relative(root, p);

  const rulesDir = join(base, "rules");
  for (const domain of listDirs(rulesDir)) {
    const dir = join(rulesDir, domain);
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) problems.push({ path: rel(dir), message: "domain has no README.md (scope, code directories, Terms)" });
    else {
      const parsed = parseDocFile(readFileSync(readme, "utf8"), rel(readme));
      if (!parsed.ok) problems.push({ path: rel(readme), message: parsed.error.message });
      else {
        const code = parsed.value.meta["code"];
        const codeList = Array.isArray(code) ? code.filter((c): c is string => typeof c === "string") : [];
        if (!Array.isArray(code)) problems.push({ path: rel(readme), message: "front matter `code` must list the code directories this domain governs" });
        domains.push({ name: domain, path: rel(readme), code: codeList, body: parsed.value.body });
      }
    }
    for (const file of listFiles(dir)) {
      if (file === "README.md") continue;
      const path = rel(join(dir, file));
      if (!RULE_FILE.test(file)) {
        problems.push({ path, message: "a rule file must be named BR-<n>.md" });
        continue;
      }
      const parsed = parseDocFile(readFileSync(join(dir, file), "utf8"), path);
      if (!parsed.ok) {
        problems.push({ path, message: parsed.error.message });
        continue;
      }
      const { meta, body } = parsed.value;
      const id = file.slice(0, -3);
      const status = meta["status"] ?? "active";
      const bad = checkCommon(meta, id) ?? (RULE_STATUS.includes(status as RuleStatus) ? undefined : `status must be one of ${RULE_STATUS.join(", ")}`);
      if (bad) {
        problems.push({ path, message: bad });
        continue;
      }
      const untested = meta["untested"];
      if (untested !== undefined && (typeof untested !== "string" || untested.trim() === "")) {
        problems.push({ path, message: "`untested` must state the reason the rule has no test" });
        continue;
      }
      const rule: Rule = {
        kind: "rule",
        id,
        title: String(meta["title"]),
        path,
        body,
        domain,
        status: status as RuleStatus,
        ...(typeof untested === "string" ? { untested } : {}),
      };
      docs.push(rule);
    }
  }

  for (const kind of ["decision", "change", "note"] as const) {
    const dir = join(base, DIR_OF[kind]);
    for (const file of listFiles(dir)) {
      const path = rel(join(dir, file));
      if (!NUMBERED_FILE[kind].test(file)) {
        problems.push({ path, message: `file name must look like ${NUMBERED_FILE[kind].source}` });
        continue;
      }
      const parsed = parseDocFile(readFileSync(join(dir, file), "utf8"), path);
      if (!parsed.ok) {
        problems.push({ path, message: parsed.error.message });
        continue;
      }
      const { meta, body } = parsed.value;
      const id = file.match(/^[A-Z]+-\d+/)![0];
      const bad = checkCommon(meta, id);
      if (bad) {
        problems.push({ path, message: bad });
        continue;
      }
      const title = String(meta["title"]);
      if (kind === "decision") {
        const status = meta["status"] ?? "proposed";
        if (!DECISION_STATUS.includes(status as DecisionStatus)) {
          problems.push({ path, message: `status must be one of ${DECISION_STATUS.join(", ")}` });
          continue;
        }
        const supersedes = meta["supersedes"];
        const d: Decision = {
          kind,
          id,
          title,
          path,
          body,
          status: status as DecisionStatus,
          ...(typeof supersedes === "string" ? { supersedes } : {}),
        };
        docs.push(d);
      } else if (kind === "change") {
        const status = meta["status"] ?? "open";
        const rules = meta["rules"] ?? [];
        if (!CHANGE_STATUS.includes(status as ChangeStatus)) {
          problems.push({ path, message: `status must be one of ${CHANGE_STATUS.join(", ")}` });
          continue;
        }
        if (!Array.isArray(rules) || rules.some((r) => typeof r !== "string")) {
          problems.push({ path, message: "`rules` must be a list of rule ids" });
          continue;
        }
        const c: Change = { kind, id, title, path, body, status: status as ChangeStatus, rules: rules as string[] };
        docs.push(c);
      } else {
        const n: Note = { kind, id, title, path, body };
        docs.push(n);
      }
    }
  }
  return { corpus: { docs, domains }, problems };
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
