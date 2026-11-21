import type { ChangeState } from "../../knowledge/changes/state.ts";
import { isClosed } from "../../knowledge/changes/state.ts";
import { DEFAULT_TIER, type Tier } from "../priority/tiers.ts";
import type { Workspace } from "../workspace.ts";
import { changeFacts, type NoticeContext } from "../delegation/notices.ts";
import type { DueItem } from "./due.ts";
import { roomDetail, type Room } from "./room.ts";

/** The tiers whose changes interrupt current work when nothing moves them (BR-2606, D-155). */
export const INTERRUPTING: ReadonlySet<Tier> = new Set<Tier>(["P0", "P1"]);

const tierOf = (s: ChangeState): Tier => s.priority?.tier ?? DEFAULT_TIER;

/** Whether `s` is a P0 or P1 change whose delegation stalled: its `interrupt:` item replaces `stalled:` (BR-2606). */
export const interruptsStalled = (s: ChangeState): boolean => s.stalled !== undefined && !isClosed(s) && INTERRUPTING.has(tierOf(s));

/** BR-2581's room as one fact: `room for 2 more` or `machine busy (<reasons>)`. */
export const roomFact = (room: Room): string => (room.room ? `room for ${room.fits} more (${roomDetail(room)})` : `machine busy (${room.reasons.join("; ")})`);

/** The changes this session holds and their tiers: `you hold C-5 P2, C-8 P1` (BR-2606). */
export function heldFact(ws: Workspace, states: readonly ChangeState[], holders: ReadonlyMap<string, string>): string {
  const mine = states.filter((s) => holders.get(s.id) === ws.actor).map((s) => `${s.id} ${tierOf(s)}`);
  return mine.length === 0 ? "you hold nothing" : `you hold ${mine.join(", ")}`;
}

const clip = (text: string, n = 60): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * BR-2606: one `interrupt:<C-n>` item for each P0 or P1 change nothing moves (it can start and no live claim binds it, or
 * its delegation stalled), with the facts the main agent weighs and both ways, never one fixed next step (D-156).
 */
export function interruptItems(ws: Workspace, states: readonly ChangeState[], room: Room, ctx: NoticeContext): DueItem[] {
  const out: DueItem[] = [];
  const held = heldFact(ws, states, ctx.holders);
  for (const s of states) {
    if (!s.change || isClosed(s) || !INTERRUPTING.has(tierOf(s))) continue;
    const ready = (s.state === "ready-delegatable" || s.state === "ready-self") && !ctx.holders.has(s.id);
    const stalled = interruptsStalled(s);
    if (!ready && !stalled) continue;
    const delegatable = s.state !== "ready-self";
    const facts = [roomFact(room), held, ...changeFacts(ctx, s.id, s.change, delegatable && !stalled)];
    const why = stalled ? `delegated to ${s.stalled!.worker}, stalled` : "nobody works on it";
    const yours = `stop one of yours (canon work stop --reason partial --next "<next>") and canon work start ${s.id}`;
    const next = stalled
      ? `canon work delegate ${s.id} --to <name> again, or canon work take ${s.id}`
      : delegatable
        ? `canon work delegate ${s.id} --to <name>, or ${yours}`
        : `${yours} (not delegatable: ${s.notDelegatable.join("; ")})`;
    out.push({
      key: `interrupt:${s.id}`,
      kind: "interrupt",
      since: stalled ? s.stalled!.since : (s.priority?.at ?? null),
      summary: `${tierOf(s)} ${clip(s.change.title)}: ${why}; ${facts.join("; ")}`,
      next,
      foldNext: "canon work delegate <n> --to <name>, or stop one of yours and canon work start <n>",
      group: "judge",
      tier: 0,
      fixOnly: tierOf(s) === "P0",
    });
  }
  return out;
}
