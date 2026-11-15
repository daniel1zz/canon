import { err, ok, type Result } from "../../kernel/result.ts";
import type { Say, Workspace } from "../workspace.ts";
import { delegation, type Delegation } from "./records.ts";

export function acceptDesign(ws: Workspace, subject: string, say: Say): Result<void> {
  const result = ws.db.db.transaction((): Result<string[]> => {
    const d = delegation(ws.db, subject);
    const c = ws.db.db.query<{ holder: string; delegation_epoch: number | null }, [string]>("SELECT holder,delegation_epoch FROM claims WHERE subject = ?").get(subject);
    if (!d || d.acceptor !== ws.actor || c?.holder !== ws.actor || c.delegation_epoch === null) return err("conflict", `${subject}: only its acceptor holding the claim can accept a design; nothing changed`);
    if (c.delegation_epoch === d.epoch) return ok([`${subject}: 已是最新 (epoch ${d.epoch})`]);
    const history = ws.db.db.query<{ id: number; detail: string }, [string, number]>("SELECT id,detail FROM events WHERE subject=? AND kind IN ('delegation.create','delegation.update') AND json_extract(detail,'$.epoch')>=? ORDER BY id").all(subject, c.delegation_epoch);
    const first = history.find((row) => (JSON.parse(row.detail) as Delegation).epoch === c.delegation_epoch);
    if (!first) return err("io", `${subject}: delegation history for epoch ${c.delegation_epoch} is missing; nothing changed`);
    const changed = new Set<string>();
    let old = (JSON.parse(first.detail) as Delegation).manifest;
    for (const row of history.filter((r) => r.id > first.id)) {
      const next = (JSON.parse(row.detail) as Delegation).manifest;
      for (const item of [...old, ...next]) if (old.find((x) => x.path === item.path)?.hash !== next.find((x) => x.path === item.path)?.hash) changed.add(item.id ?? item.path);
      old = next;
    }
    const answers = ws.db.db.query<{ detail: string }, [string, number]>("SELECT detail FROM events WHERE kind='design.answer' AND subject=? AND id>? ORDER BY id").all(subject, first.id);
    const lines = [`${subject}: accepted design epoch ${c.delegation_epoch} → ${d.epoch}; revision ${d.revision}`, `changed contract items: ${[...changed].join(", ") || "none"}`];
    for (const row of answers) { const a = JSON.parse(row.detail) as { request: number; answer: string }; lines.push(`design request #${a.request}: ${a.answer}`); }
    ws.db.db.query("UPDATE claims SET delegation_epoch=?,version=version+1 WHERE subject=? AND holder=?").run(d.epoch, subject, ws.actor);
    ws.db.event(ws.actor, "delegation.accept", subject, { from: c.delegation_epoch, epoch: d.epoch, revision: d.revision, changed: [...changed] });
    return ok(lines);
  }).immediate();
  if (!result.ok) return result;
  for (const line of result.value) say(line);
  return ok(undefined);
}
