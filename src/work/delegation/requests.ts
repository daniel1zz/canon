import { git } from "../../kernel/git.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import type { CoordDb } from "../db.ts";
import type { Workspace } from "../workspace.ts";
import { delegation } from "./records.ts";
import { isWorker } from "./worker.ts";

/**
 * Design requests (BR-2499, D-128): a worker hands an undecided or contradictory design back with
 * `canon work need-design`, and the change's current design owner answers with `canon work design-answer`.
 * A request belongs to the change, so it follows the design owner when the change is delegated again.
 * These are not human answers (`canon human`, P7).
 */

export interface DesignRequest {
  readonly id: number;
  readonly subject: string;
  readonly asked_by: string;
  readonly request: string;
  readonly status: "pending" | "answered";
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly main: string | null;
  readonly asked_at: string;
  readonly answered_at: string | null;
}

export function needDesign(ws: Workspace, subject: string, text: string): Result<{ id: number; owner: string }> {
  if (text.trim() === "") return err("invalid", "the request is empty: say what is undecided or contradictory, which rules or files it touches, and which work stops because of it");
  return ws.db.db.transaction((): Result<{ id: number; owner: string }> => {
    const d = delegation(ws.db, subject);
    if (!d) return err("not_found", `${subject} is not delegated (未派发); a design request goes to the design owner of a delegated change`);
    const c = ws.db.db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(subject);
    if (!isWorker(ws.actor) || d.ended || d.acceptor !== ws.actor || c?.holder !== ws.actor) {
      return err("invalid", `${subject}: only the worker holding this delegated change can hand back a design question (holder ${c?.holder ?? "none"}, acceptor ${d.acceptor ?? "none"}; you are ${ws.actor}); the design owner ${d.owner} changes the design itself`);
    }
    const id = Number(
      ws.db.db
        .query("INSERT INTO design_requests(subject, asked_by, request, status, asked_at) VALUES (?, ?, ?, 'pending', ?)")
        .run(subject, ws.actor, text, new Date().toISOString()).lastInsertRowid,
    );
    ws.db.event(ws.actor, "design.request", subject, { request: id, text, owner: d.owner });
    return ok({ id, owner: d.owner });
  }).immediate();
}

export function designAnswer(ws: Workspace, number: string, answer: string): Result<DesignRequest> {
  const m = /^#?(\d+)$/.exec(number.trim());
  if (!m) return err("invalid", `${JSON.stringify(number)} is not a design request number (#n)`);
  if (answer.trim() === "") return err("invalid", "the answer is empty");
  const id = Number(m[1]);
  const main = git(ws.primary, "rev-parse", "--verify", `${ws.config.main}^{commit}`);
  if (!main.ok) return main;
  return ws.db.db.transaction((): Result<DesignRequest> => {
    const row = requestById(ws.db, id);
    if (!row) return err("not_found", `design request #${id} does not exist`);
    const d = delegation(ws.db, row.subject);
    if (!d || d.owner !== ws.actor) return err("invalid", `#${id} is on ${row.subject}, whose current design owner is ${d?.owner ?? "nobody"}; only that design owner can answer it (you are ${ws.actor})`);
    if (row.status === "answered") return err("conflict", `#${id} was already answered by ${row.answered_by} at ${row.answered_at}; the answer stays`);
    const at = new Date().toISOString();
    ws.db.db.query("UPDATE design_requests SET status = 'answered', answer = ?, answered_by = ?, main = ?, answered_at = ? WHERE id = ? AND status = 'pending'").run(answer, ws.actor, main.value, at, id);
    // reason: accept-design reads this exact detail shape (BR-2498, C-570)
    ws.db.event(ws.actor, "design.answer", row.subject, { request: id, answer, main: main.value });
    return ok({ ...row, status: "answered", answer, answered_by: ws.actor, main: main.value, answered_at: at });
  }).immediate();
}

function requestById(db: CoordDb, id: number): DesignRequest | undefined {
  return db.db.query<DesignRequest, [number]>("SELECT * FROM design_requests WHERE id = ?").get(id) ?? undefined;
}

export function pendingRequests(db: CoordDb): (DesignRequest & { owner: string | null })[] {
  return db.db
    .query<DesignRequest & { owner: string | null }, []>("SELECT r.*, d.owner AS owner FROM design_requests r LEFT JOIN delegations d ON d.subject = r.subject WHERE r.status = 'pending' ORDER BY r.id")
    .all();
}

/** The pending requests on the changes this actor is the current design owner of: its `canon brief` lists them (BR-2499). */
export function ownerRequestLines(db: CoordDb, actor: string): string[] {
  return pendingRequests(db)
    .filter((r) => r.owner === actor)
    .map((r) => `Design request #${r.id} on ${r.subject} from ${r.asked_by} waits for you, its design owner: ${r.request} (answer with canon work design-answer ${r.id} "<answer>")`);
}

/** Every request on a change with its answer: what the worker holding it sees in `canon brief` (BR-2499). */
export function changeRequestLines(db: CoordDb, subject: string): string[] {
  return db.db
    .query<DesignRequest, [string]>("SELECT * FROM design_requests WHERE subject = ? ORDER BY id")
    .all(subject)
    .map((r) => r.status === "pending"
      ? `Design request #${r.id} (pending, from ${r.asked_by}): ${r.request}`
      : `Design request #${r.id} (answered by ${r.answered_by} at main ${r.main}): ${r.request} — answer: ${r.answer}`);
}

/** One line per pending request with its current design owner, for `canon work status` (BR-2499). */
export function statusRequestLines(db: CoordDb): string[] {
  return pendingRequests(db).map((r) => `  #${r.id} ${r.subject.padEnd(8)} from ${r.asked_by}, design owner ${r.owner ?? "none"}: ${r.request}`);
}
