import { createHash } from "node:crypto";
import { git } from "../../kernel/git.ts";
import type { Result } from "../../kernel/result.ts";
import { ok } from "../../kernel/result.ts";
import { isWorker } from "../delegation/worker.ts";
import { agenda, entryLine, folded, readyLine, type AgendaOptions } from "../reminders/agenda.ts";
import type { Workspace } from "../workspace.ts";

/** The dispatch check at a main session's stop (BR-2655, BR-2660, D-170). */

/** The most lines of things to do the reason names (BR-2655). */
const SHOWN = 5;
/** A judge item whose next step belongs to another session is not this session's to do now (BR-2655). */
const ELSEWHERE = "needs another session";
const OFF_LINE = "dispatch check: off for this session (canon goal dispatch on turns it back on)";

export const dispatchOff = (ws: Workspace, actor: string): boolean => ws.db.db.query<{ off: number }, [string]>("SELECT off FROM dispatch_state WHERE actor = ?").get(actor)?.off === 1;

/** `canon goal dispatch [on|off]` (BR-2660): the line it prints. */
export function setDispatch(ws: Workspace, actor: string, to: "on" | "off" | undefined): string {
  if (to === undefined) return dispatchOff(ws, actor) ? OFF_LINE : "dispatch check: on";
  if (to === "off") {
    ws.db.db.query("INSERT INTO dispatch_state(actor, off, marker) VALUES (?, 1, NULL) ON CONFLICT(actor) DO UPDATE SET off = 1, marker = NULL").run(actor);
    ws.db.event(actor, "dispatch.off", null, {});
    return OFF_LINE;
  }
  if (dispatchOff(ws, actor)) {
    ws.db.db.query("UPDATE dispatch_state SET off = 0, marker = NULL WHERE actor = ?").run(actor);
    ws.db.event(actor, "dispatch.on", null, {});
  }
  return "dispatch check: on";
}

/** This session's own latest event (it or its subagents, never dispatch.hold), its worktree's HEAD and status: equal means no progress (BR-2655). */
function ownMarker(ws: Workspace, actor: string, cwd: string): string {
  const like = `${actor.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
  const last = ws.db.db.query<{ id: number | null }, [string, string]>("SELECT max(id) AS id FROM events WHERE (actor = ? OR actor LIKE ? ESCAPE '\\') AND kind != 'dispatch.hold'").get(actor, like)?.id ?? 0;
  const out = (r: Result<string>) => (r.ok ? r.value.trim() : "?");
  // reason: main is left out on purpose: another session's landing moves it, and that is not this session's progress (BR-2655)
  return [String(last), out(git(cwd, "rev-parse", "HEAD")), createHash("sha256").update(out(git(cwd, "status", "--porcelain"))).digest("hex")].join(" ");
}

/**
 * The dispatch check (BR-2655): a block with what this session can do now, or undefined to let it stop.
 * `hookActor` is the hook process's own identity (a worker launcher sets it), `actor` the session the host named.
 */
export function checkDispatch(ws: Workspace, hookActor: string, actor: string, cwd: string, opts: AgendaOptions = {}): Result<{ decision: "block"; reason: string } | undefined> {
  if (isWorker(hookActor) || isWorker(actor) || dispatchOff(ws, actor)) return ok(undefined);
  const now = opts.now ?? Date.now();
  const a = agenda({ ...ws, actor }, { ...opts, now });
  if (!a.ok) return a;
  const d = a.value.delegate;
  const ready = d && d.room.room ? d.ready : [];
  const judge = folded(a.value.judge.filter((it) => !it.next.startsWith(ELSEWHERE)));
  const lines = [...ready.map((r) => ({ keys: [`ready:${r.id}`], text: readyLine(r) })), ...judge.map((g) => ({ keys: g.map((it) => it.key), text: entryLine(g, now) }))];
  const row = ws.db.db.query<{ marker: string | null }, [string]>("SELECT marker FROM dispatch_state WHERE actor = ?").get(actor);
  if (lines.length === 0) {
    if (row?.marker) ws.db.db.query("UPDATE dispatch_state SET marker = NULL WHERE actor = ?").run(actor);
    return ok(undefined);
  }
  const marker = ownMarker(ws, actor, cwd);
  if (row?.marker === marker) {
    // reason: stopping again with nothing done is the session's answer (waiting on the owner or running work); clearing lets the next turn's first stop be checked again (BR-2655)
    ws.db.db.query("UPDATE dispatch_state SET marker = NULL WHERE actor = ?").run(actor);
    return ok(undefined);
  }
  const shown = lines.slice(0, SHOWN);
  ws.db.event(actor, "dispatch.hold", null, { items: shown.flatMap((l) => l.keys) });
  ws.db.db.query("INSERT INTO dispatch_state(actor, off, marker) VALUES (?, 0, ?) ON CONFLICT(actor) DO UPDATE SET marker = excluded.marker").run(actor, marker);
  const reason = [
    "Dispatch (canon work due): before stopping, act on what you can do now, or stop again to leave it:",
    ...shown.map((l) => `- ${l.text}`),
    ...(lines.length > SHOWN ? [`… ${lines.length - SHOWN} more: canon work due`] : []),
    "Waiting for the owner's answer or for running work: stop again. The owner asked to pause: canon goal dispatch off.",
  ].join("\n");
  return ok({ decision: "block", reason });
}
