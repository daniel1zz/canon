import { posix } from "node:path";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Corpus } from "../documents/model.ts";
import { CANON_DIR } from "../documents/read.ts";
import { typeNamed } from "../documents/types.ts";
import { computeLinks, fingerprint, isLinkable, proseIds, type Baseline, type BaselineOf, type Link, type LinkKind } from "./links.ts";

/**
 * BR-2424: the history baseline of every reference, read from the first-parent chain of HEAD with one `git log` and one
 * `git cat-file --batch`, then the working tree as the newest step. Nothing is stored: the same commit and working tree
 * always give the same answer (D-95; about 0.1 s on canon's own history).
 */

interface Version {
  readonly fingerprint: string;
  readonly refs: ReadonlySet<string>;
}

/** One step of the walk: each document id written in it, with its version, or null when it was deleted. */
type Step = Map<string, Version | null>;

/** Every reference of the corpus with whether it is suspect, read against this checkout's history (BR-2423, BR-2424). */
export function linksOf(root: string, corpus: Corpus): Result<Link[]> {
  const baselines = readBaselines(root, corpus);
  return baselines.ok ? ok(computeLinks(corpus, baselines.value)) : baselines;
}

export function readBaselines(root: string, corpus: Corpus): Result<BaselineOf> {
  const steps = readHistory(root, corpus);
  if (!steps.ok) return steps;
  const commits = steps.value.commits;
  // The working tree is the newest step: what the corpus holds now (BR-2424).
  const now: Step = new Map();
  for (const d of corpus.docs) if (isLinkable(d)) now.set(d.id, { fingerprint: fingerprint(d.kind, d.body), refs: proseIds(corpus.types, d.id, d.body) });
  const written = [...steps.value.steps, now];
  // reason: ids that left the corpus are deleted in the working-tree step, so a history-only id never counts as current
  for (const step of steps.value.steps) for (const id of step.keys()) if (!now.has(id)) now.set(id, null);

  const timeline = new Map<string, { at: number; fingerprint: string }[]>();
  const current = new Map<string, Version>();
  const checked = new Map<string, Map<string, number>>();
  written.forEach((step, at) => {
    for (const [id, version] of step) {
      const before = current.get(id);
      if (version === null) {
        current.delete(id);
        checked.delete(id);
        continue;
      }
      // A new fingerprint, or a new document, is a check against everything it names now (BR-2424).
      const changed = before === undefined || before.fingerprint !== version.fingerprint;
      if (changed) {
        const line = timeline.get(id) ?? [];
        line.push({ at, fingerprint: version.fingerprint });
        timeline.set(id, line);
      }
      const refs = checked.get(id) ?? new Map<string, number>();
      for (const r of version.refs) if (before === undefined || changed || !before.refs.has(r) || !refs.has(r)) refs.set(r, at);
      for (const r of [...refs.keys()]) if (!version.refs.has(r)) refs.delete(r);
      checked.set(id, refs);
      current.set(id, version);
    }
  });

  const fingerprintAt = (id: string, at: number): string | undefined => {
    const line = timeline.get(id);
    if (!line || line.length === 0) return undefined;
    // reason: a document named before it existed was written against its first version (BR-2424)
    let found = line[0]!.fingerprint;
    for (const v of line) {
      if (v.at > at) break;
      found = v.fingerprint;
    }
    return found;
  };
  return ok((from: string, to: string): Baseline | undefined => {
    const at = checked.get(from)?.get(to);
    if (at === undefined) return undefined;
    const fp = fingerprintAt(to, at);
    if (fp === undefined) return undefined;
    return { fingerprint: fp, commit: at < commits.length ? commits[at] : undefined };
  });
}

interface History {
  readonly commits: readonly string[];
  readonly steps: readonly Step[];
}

/** The versions of every rule and decision file on HEAD's first-parent chain, oldest first; empty when there is no commit yet. */
function readHistory(root: string, corpus: Corpus): Result<History> {
  const head = git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (!head.ok) {
    // reason: a repository without a commit has no history, which is not a failure (BR-2427); anything else is
    const repo = git(root, "rev-parse", "--git-dir");
    return repo.ok ? ok({ commits: [], steps: [] }) : repo;
  }
  const ruleType = typeNamed(corpus.types, "rule")!;
  const decisionType = typeNamed(corpus.types, "decision")!;
  const ruleDir = `${CANON_DIR}/${ruleType.dir}`;
  const decisionDir = `${CANON_DIR}/${decisionType.dir}`;
  const ruleFile = new RegExp(`^(${ruleType.prefix}-\\d+)\\.md$`);
  const decisionFile = new RegExp(`^(${decisionType.prefix}-\\d+)(-[a-z0-9-]+)?\\.md$`);
  const classify = (path: string): { id: string; kind: LinkKind } | undefined => {
    const name = posix.basename(path);
    if (path.startsWith(`${ruleDir}/`)) {
      const m = ruleFile.exec(name);
      return m ? { id: m[1]!, kind: "rule" } : undefined;
    }
    if (posix.dirname(path) === decisionDir) {
      const m = decisionFile.exec(name);
      return m ? { id: m[1]!, kind: "decision" } : undefined;
    }
    return undefined;
  };

  const log = git(root, "-c", "core.quotePath=false", "log", "--first-parent", "--reverse", "--format=>%H", "--raw", "--no-abbrev", "--no-renames", "HEAD", "--", ruleDir, decisionDir);
  if (!log.ok) return log;
  const commits: string[] = [];
  const raw: Map<string, { kind: LinkKind; blob: string | null }>[] = [];
  for (const line of log.value.split("\n")) {
    if (line.startsWith(">")) {
      commits.push(line.slice(1));
      raw.push(new Map());
      continue;
    }
    if (!line.startsWith(":")) continue;
    const tab = line.indexOf("\t");
    const fields = line.slice(1, tab).split(" ");
    const doc = classify(line.slice(tab + 1));
    if (!doc) continue;
    const step = raw[raw.length - 1]!;
    const deleted = fields[4] === "D";
    // reason: a move is a delete and an add of the same id in one commit; the added version wins, whatever the path order
    if (deleted) {
      if (!step.has(doc.id)) step.set(doc.id, { kind: doc.kind, blob: null });
    } else step.set(doc.id, { kind: doc.kind, blob: fields[3]! });
  }

  const blobs = [...new Set(raw.flatMap((s) => [...s.values()].map((v) => v.blob).filter((b): b is string => b !== null)))];
  const texts = catBlobs(root, blobs);
  if (!texts.ok) return texts;
  const versions = new Map<string, Version | undefined>();
  const versionOf = (blob: string, kind: LinkKind, id: string): Version | undefined => {
    const key = `${kind} ${id} ${blob}`;
    if (!versions.has(key)) {
      const body = bodyOf(texts.value.get(blob)!);
      versions.set(key, body === undefined ? undefined : { fingerprint: fingerprint(kind, body), refs: proseIds(corpus.types, id, body) });
    }
    return versions.get(key);
  };
  const steps: Step[] = raw.map((s) => {
    const step: Step = new Map();
    for (const [id, { kind, blob }] of s) {
      if (blob === null) step.set(id, null);
      else {
        // reason: a version whose front matter does not parse says nothing about its prose; the previous version stands
        const v = versionOf(blob, kind, id);
        if (v) step.set(id, v);
      }
    }
    return step;
  });
  return ok({ commits, steps });
}

/**
 * The body of a document file as `parseDocFile` splits it, without parsing the YAML: only the body counts here, and
 * parsing the front matter of every old version costs most of the walk. Undefined without front matter.
 */
function bodyOf(text: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 3);
  return end < 0 ? undefined : text.slice(end + 5).replace(/^\n/, "");
}

/** The text of each blob, read with one `git cat-file --batch`. */
function catBlobs(root: string, blobs: readonly string[]): Result<Map<string, string>> {
  const out = new Map<string, string>();
  if (blobs.length === 0) return ok(out);
  const r = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root, stdin: Buffer.from(`${blobs.join("\n")}\n`), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return err("io", `git cat-file --batch: ${r.stderr.toString().trim()}`);
  const buf = r.stdout;
  const decoder = new TextDecoder();
  let at = 0;
  for (const blob of blobs) {
    const nl = buf.indexOf(10, at);
    const header = decoder.decode(buf.subarray(at, nl)).split(" ");
    if (header[1] !== "blob") return err("io", `git cat-file --batch: ${blob} is ${header.slice(1).join(" ")}`);
    const size = Number(header[2]);
    out.set(blob, decoder.decode(buf.subarray(nl + 1, nl + 1 + size)));
    at = nl + 1 + size + 1;
  }
  return ok(out);
}
