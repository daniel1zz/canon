import { posix } from "node:path";
import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { Corpus } from "../documents/model.ts";
import { CANON_DIR } from "../documents/read.ts";
import { typeNamed, type DocType } from "../documents/types.ts";
import { computeLinks, fingerprint, proseIds, type DocAt, type Link, type LinkKind, type Start } from "./links.ts";

/**
 * BR-2424: the starting commit `links_since` names, read as one tree (one `git ls-tree`, one `git cat-file --batch`);
 * no history walk, so the answer depends on that commit and the working tree only, never on how much history the
 * clone holds. A starting commit that is unset or not in HEAD's history fails loud (D-95).
 */

/** Every reference of the corpus with whether it is suspect (BR-2423, BR-2424, BR-2425). */
export function linksOf(root: string, corpus: Corpus, since: string | undefined): Result<Link[]> {
  const start = readStart(root, corpus.types, since);
  return start.ok ? ok(computeLinks(corpus, start.value)) : start;
}

/** The starting commit's rules and decisions; undefined in a repository without a commit (BR-2424). */
export function readStart(root: string, types: readonly DocType[], since: string | undefined): Result<Start | undefined> {
  const head = git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (!head.ok) {
    // reason: a repository without a commit has nothing landed to compare with, which is not a failure (BR-2424); anything else is
    const repo = git(root, "rev-parse", "--git-dir");
    return repo.ok ? ok(undefined) : repo;
  }
  if (since === undefined) {
    return err("io", "canon/config.yaml has no links_since: set it to the full id of the commit before which every reference counts as confirmed (for a new project the current main: git rev-parse main), so suspect references can be told (BR-2424)");
  }
  // reason: a shallow clone or rewritten history lacks the starting commit; saying "no suspect references" then would be a guess (BR-2424)
  const reachable = git(root, "merge-base", "--is-ancestor", since, head.value);
  if (!reachable.ok) {
    return err("io", `links_since ${since.slice(0, 9)} is not in the history of HEAD (a shallow clone, rewritten history, or a branch older than the setting): fetch the full history (git fetch --unshallow) or rebase onto main; suspect references cannot be told without it (BR-2424)`);
  }
  const docs = docsAt(root, types, since);
  return docs.ok ? ok({ commit: since, docs: docs.value }) : docs;
}

/** The rules and decisions of commit `rev`'s tree, by id, each with its fingerprint and the ids its prose names. */
export function docsAt(root: string, types: readonly DocType[], rev: string): Result<Map<string, DocAt>> {
  const ruleType = typeNamed(types, "rule")!;
  const decisionType = typeNamed(types, "decision")!;
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
  const listed = git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "--full-tree", rev, "--", ruleDir, decisionDir);
  if (!listed.ok) return listed;
  const files: { id: string; kind: LinkKind; blob: string }[] = [];
  for (const line of listed.value.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [, type, blob] = line.slice(0, tab).split(" ");
    const doc = type === "blob" ? classify(line.slice(tab + 1)) : undefined;
    if (doc) files.push({ ...doc, blob: blob! });
  }
  const texts = catBlobs(root, [...new Set(files.map((f) => f.blob))]);
  if (!texts.ok) return texts;
  const out = new Map<string, DocAt>();
  for (const f of files) {
    const parts = partsOf(texts.value.get(f.blob)!);
    // reason: a file without front matter is no document (canon check reports it); it names nothing and is named as missing
    if (parts === undefined) continue;
    out.set(f.id, { fingerprint: fingerprint(f.kind, parts.body, parts.status), refs: proseIds(types, f.id, parts.body) });
  }
  return ok(out);
}

/**
 * The body and status of a document file as `parseDocFile` splits it, without parsing the YAML: parsing the front
 * matter of every file costs most of the read. Undefined without front matter.
 */
function partsOf(text: string): { body: string; status: string | undefined } | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return undefined;
  const status = /^status:[ \t]*["']?([^"'\s#]+)/m.exec(text.slice(4, end))?.[1];
  return { body: text.slice(end + 5).replace(/^\n/, ""), status };
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
