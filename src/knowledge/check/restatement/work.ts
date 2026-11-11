import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { git, toplevel } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import { readConfig } from "../../../invocation/config.ts";
import { readCorpus } from "../../documents/read.ts";
import type { Corpus, Doc } from "../../documents/model.ts";
import { addedLines, restatementIndex, restatementsIn, type Restatement, type RestatementIndex } from "./restatement.ts";

/**
 * The restatements a piece of work wrote: in the lines of a rule or decision that are not in the same file where the
 * work started from main (BR-2402, BR-2403, BR-2405).
 */

/** Where this work started from main: the merge base of HEAD and `main` (on main itself, main's head). */
export function workBase(root: string, main: string): Result<string> {
  const at = git(root, "rev-parse", "--verify", `${main}^{commit}`);
  if (!at.ok) return err("io", `the main branch ${main} cannot be read: ${at.error.message}`);
  return git(root, "merge-base", "HEAD", at.value);
}

/** The text a file had at `base`; undefined when it did not exist there (a new file: every line is new). */
export function textAt(root: string, base: string, path: string): string | undefined {
  // reason: cat-file -e tells "not there" from a failing git; only "not there" means a new file
  if (!git(root, "cat-file", "-e", `${base}:${path}`).ok) return undefined;
  const t = git(root, "show", `${base}:${path}`);
  return t.ok ? `${t.value}\n` : undefined;
}

/** The restatements in the lines of `doc` (as it is now under `root`) that are not lines of it at `base`. */
export function addedRestatements(root: string, base: string, doc: Doc, index: RestatementIndex): Restatement[] {
  const now = readFileSync(join(root, doc.path), "utf8");
  return restatementsIn(index, doc, now, addedLines(now, textAt(root, base, doc.path)));
}

/** The restatements in the added lines of each of `docs`, one index for all. */
export function workRestatements(root: string, base: string, corpus: Corpus, docs: readonly Doc[]): Restatement[] {
  const index = restatementIndex(corpus);
  return docs.flatMap((d) => addedRestatements(root, base, d, index));
}

const WATCHED = /^canon\/(?:rules|decisions)\/.+\.md$/;

/** The rule or decision a Write or Edit just changed, read with the corpus around it; undefined when the file is none (BR-2402). */
export interface EditedDoc {
  readonly root: string;
  readonly corpus: Corpus;
  readonly doc: Doc;
  readonly main: string;
}

export function editedDoc(file: string): Result<EditedDoc | undefined> {
  const dir = dirname(file);
  if (!existsSync(dir)) return ok(undefined);
  const top = toplevel(dir);
  if (!top.ok) return ok(undefined);
  const root = top.value;
  // reason: git prints the toplevel with links resolved, so the file's directory is resolved too before comparing paths
  const rel = relative(root, join(realpathSync(dir), basename(file))).split("\\").join("/");
  if (!WATCHED.test(rel) || !existsSync(join(root, "canon", "config.yaml"))) return ok(undefined);
  const config = readConfig(root);
  if (!config.ok) return config;
  const corpus = readCorpus(root, config.value.types, config.value).corpus;
  const doc = corpus.docs.find((d) => d.path === rel);
  return ok(doc ? { root, corpus, doc, main: config.value.main } : undefined);
}

/** The hook's finding for an edited rule or decision (BR-2402): the restatements in its new lines. */
export function editedRestatements(edited: EditedDoc): Result<Restatement[]> {
  const base = workBase(edited.root, edited.main);
  if (!base.ok) return base;
  return ok(addedRestatements(edited.root, base.value, edited.doc, restatementIndex(edited.corpus)));
}
