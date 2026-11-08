import type { CoordDb } from "../db.ts";
import { eventsSince } from "./window.ts";

/**
 * What the batches (`batch.start` .. `batch.end`) of an event window did, so "why do batches land alone" is one
 * command (BR-2379): how each leader ended, and why members left without landing.
 */
export interface BatchStats {
  readonly batches: number;
  /** Batches with a `batch.start` and no `batch.end`: the leader's process stopped mid-batch, or the batch is older than `batch.end`. */
  readonly unended: number;
  /** Leader outcomes of the ended batches; `landedAlone` is a leader that landed with no member, `landedWith` one that landed with at least one. */
  readonly leaders: { readonly landedWith: number; readonly landedAlone: number; readonly gaveUp: number; readonly lostTurn: number; readonly error: number; readonly refused: Readonly<Record<string, number>> };
  readonly members: { readonly joined: number; readonly landed: number; readonly sentBack: Readonly<Record<string, number>> };
}

const byCount = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

/** Batch statistics over the events after `since`, up to `until` (BR-2379). */
export function batchStats(db: CoordDb, since: number, until: number): BatchStats {
  const rows = eventsSince(db, { since, until, kinds: ["batch.start", "batch.end", "batch.drop"] });
  const starts = rows.filter((r) => r.kind === "batch.start");
  const ends = rows.filter((r) => r.kind === "batch.end");
  const refused: Record<string, number> = {};
  let landedWith = 0;
  let landedAlone = 0;
  let gaveUp = 0;
  let lostTurn = 0;
  let error = 0;
  let landed = 0;
  for (const e of ends) {
    const members = Array.isArray(e.detail["landed"]) ? e.detail["landed"].length : 0;
    landed += members;
    switch (e.detail["leader"]) {
      case "landed": if (members > 0) landedWith++; else landedAlone++; break;
      case "alone": gaveUp++; break;
      case "lost-turn": lostTurn++; break;
      case "refused": { const reason = typeof e.detail["reason"] === "string" ? e.detail["reason"] : "unrecorded"; refused[reason] = (refused[reason] ?? 0) + 1; break; }
      default: error++;
    }
  }
  const sentBack: Record<string, number> = {};
  for (const d of rows.filter((r) => r.kind === "batch.drop")) {
    const reason = typeof d.detail["reason"] === "string" ? d.detail["reason"] : "unrecorded";
    sentBack[reason] = (sentBack[reason] ?? 0) + 1;
  }
  const joined = starts.reduce((n, r) => n + (Array.isArray(r.detail["members"]) ? r.detail["members"].length : 0), 0);
  return {
    batches: starts.length,
    unended: Math.max(0, starts.length - ends.length),
    leaders: { landedWith, landedAlone, gaveUp, lostTurn, error, refused: byCount(refused) },
    members: { joined, landed, sentBack: byCount(sentBack) },
  };
}

const list = (m: Readonly<Record<string, number>>) => {
  const e = Object.entries(m);
  return e.length ? ` (${e.map(([k, c]) => `${k} ${c}`).join(", ")})` : "";
};

/** The batch section of `canon stats`; empty when no batch started in the window. */
export function renderBatchStats(b: BatchStats): string {
  if (b.batches === 0) return "";
  const refused = Object.values(b.leaders.refused).reduce((n, c) => n + c, 0);
  const sent = Object.values(b.members.sentBack).reduce((n, c) => n + c, 0);
  return [
    `batches: ${b.batches} started, ${b.batches - b.unended} ended${b.unended ? `, ${b.unended} without a batch.end (the leader stopped mid-batch, or it ran before batch.end existed)` : ""}`,
    `  leader: landed with members ${b.leaders.landedWith}, landed alone ${b.leaders.landedAlone}, refused ${refused}${list(b.leaders.refused)}, gave up and went on alone ${b.leaders.gaveUp}, lost its turn ${b.leaders.lostTurn}, error ${b.leaders.error}`,
    `  members: ${b.members.joined} joined, ${b.members.landed} landed, ${sent} left without landing${list(b.members.sentBack)}`,
  ].join("\n");
}
