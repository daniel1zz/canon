import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Say, Workspace } from "../../workspace.ts";
import { git } from "../../../kernel/git.ts";
import { err, ok, type Result } from "../../../kernel/result.ts";
import { lightChangeOf } from "../../../knowledge/query/query.ts";
import { slugify, type Corpus } from "../../../knowledge/documents/model.ts";
import { renderDocFile } from "../../../knowledge/documents/docfile.ts";
import { highestNumber } from "../../../knowledge/documents/write.ts";
import { CANON_DIR } from "../../../knowledge/documents/read.ts";
import { branchSlug } from "../../session/subject.ts";
import { closeSubject, type CloseCommit } from "./finish.ts";

/**
 * A chore is a light change (D-148): it starts with a title only, and its change file and C number are written by its
 * landing, in the close commit with its work, so main gets no open commit and a chore that never lands leaves nothing
 * (BR-2457, BR-2458, D-150). The work keeps its chore identity; the file's `chore` key names it.
 */

/** The title `canon chore start` recorded, or undefined when the record is gone (BR-2457). */
function recordedTitle(ws: Workspace, subject: string): string | undefined {
  const row = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'chore.start' AND subject = ? ORDER BY id LIMIT 1").get(subject);
  const title = row ? (JSON.parse(row.detail) as { title?: unknown }).title : undefined;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
}

/**
 * The C number of the chore's light change: the one its first close commit took, so a landing tried again keeps it
 * (BR-2458), unless another document of the tree has that id; else a new one, recorded for the next attempt.
 */
function lightNumber(ws: Workspace, subject: string, corpus: Corpus, prefix: string): string {
  const row = ws.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'chore.number' AND subject = ? ORDER BY id DESC LIMIT 1").get(subject);
  const kept = row ? (JSON.parse(row.detail) as { id?: unknown }).id : undefined;
  if (typeof kept === "string" && !corpus.docs.some((d) => d.id === kept)) return kept;
  const id = ws.db.allocate(prefix, highestNumber(corpus, prefix), ws.actor);
  ws.db.event(ws.actor, "chore.number", subject, { id });
  return id;
}

/**
 * Makes the chore's close commit `canon: close <identity>` with its new light change file, before the landing queues
 * (BR-2458). Returns the close commit to take back if the landing does not reach main (BR-2018), or undefined when the
 * worktree already has the file (a close commit a failed take-back left): it lands as it is, like a change already done.
 */
export function closeLight(ws: Workspace, wt: string, subject: string, corpus: Corpus, say: Say): Result<CloseCommit | undefined> {
  if (lightChangeOf(corpus, subject)) return ok(undefined);
  const type = corpus.types.find((t) => t.name === "change");
  if (!type) return err("invalid", "this project declares no change type, so the chore's light change file cannot be written (BR-2458)");
  let title = recordedTitle(ws, subject);
  if (title === undefined) {
    const branch = git(wt, "symbolic-ref", "--quiet", "--short", "HEAD");
    title = (branch.ok ? branchSlug(branch.value) : undefined) || subject;
    say(`${subject}: full title unavailable; the change file takes the branch slug as its title`);
  }
  const id = lightNumber(ws, subject, corpus, type.prefix);
  const slug = slugify(title);
  const path = join(CANON_DIR, type.dir, slug ? `${id}-${slug}.md` : `${id}.md`);
  const full = join(wt, path);
  if (existsSync(full)) return err("conflict", `${path} already exists; the chore's light change file was not written (BR-2458)`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderDocFile({ id, title, status: "done", rules: [], chore: subject }, ""));
  // reason: the file was created a moment ago by this landing, so removing it after a failed commit loses no one's edit
  const undo = (why: string): Result<CloseCommit | undefined> => {
    git(wt, "reset", "-q", "--", path);
    rmSync(full, { force: true });
    return err("io", `the close commit could not be made: ${why}`);
  };
  const add = git(wt, "add", "--", path);
  if (!add.ok) return undo(add.error.message);
  const commit = git(wt, "commit", "-q", "-m", closeSubject(subject), "-m", `${id} ${title}`);
  if (!commit.ok) return undo(commit.error.message);
  return ok({ subject, doc: id, path, stamped: [] });
}
