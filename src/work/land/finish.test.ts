import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, takeClaim } from "../claims/claims.ts";
import { enqueue, finishEntry, tryTurn } from "./queue.ts";
import { handoffs, writeHandoff } from "../session/handoffs.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { land, reopen } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: these tests wait out real time on purpose (sleeps, leases, stale times) or drive a spawned `canon work land`;
// under load that alone came within 0.4 s of the 5 s default (C-111), so they get room, not the rest of the file.
const TIMED = 30_000;

describe("lessons when a change closes", () => {
  const setLessons = (wt: string, change: string, lessons: string | undefined) => {
    const name = readdirSync(join(wt, "canon/changes")).find((f) => f === `${change}.md` || f.startsWith(`${change}-`))!;
    const path = join(wt, "canon/changes", name);
    const text = readFileSync(path, "utf8").replace(/\n## 教训\n\n[^#]*/, "\n");
    writeFileSync(path, lessons === undefined ? text : text.replace("\n## 任务", `\n## 教训\n\n${lessons}\n\n## 任务`));
    sh(wt, "commit", "-qam", "lessons");
  };
  const subjects = (root: string) => sh(root, "log", "--format=%s", "main");

  test("BR-2161: --finish refuses an open change without a filled lessons section, before any close commit", async () => {
    const root = project();
    const s = startNew(root, "No lessons");
    setLessons(s.worktree, s.change, undefined);
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out).toMatchObject({ kind: "refused", reason: "lessons" });
    expect(out.kind === "refused" && out.message).toContain("## 教训");
    expect(sh(s.worktree, "log", "-1", "--format=%s")).toBe("lessons"); // no close commit
    expect(subjects(root)).not.toContain(`close ${s.change}`);

    setLessons(s.worktree, s.change, "<每条教训一行>");
    expect(await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "lessons" });
  });

  test("BR-2161: a lessons section saying 无 closes the change; land without --finish never asks for it", async () => {
    const root = project();
    const plain = startNew(root, "Plain land");
    setLessons(plain.worktree, plain.change, undefined);
    expect((await land(ws(plain.worktree), FAST, quiet)).kind).toBe("landed");
    const s = startNew(root, "With lessons"); // startNew writes "## 教训\n\n无。"
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
  });
});

describe("the claim during a landing", () => {
  test("BR-2108: a landing that waits longer than the lease keeps its claim renewed, so no one takes it meanwhile", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nclaim_lease_hours: 0.0003\n"); // about 1 s
    sh(root, "commit", "-qam", "tiny lease");
    const s = startNew(root, "Long wait");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, quiet);
    await Bun.sleep(2500); // two and a half leases
    expect(takeClaim(other.db, s.change, s.worktree, "agent:b", 1000).ok).toBe(false);
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  }, TIMED);

  test("BR-2018: a refused --finish landing takes its close commit back, so the change stays open", async () => {
    const root = project();
    const s = startNew(root, "Refused finish");
    writeFileSync(join(s.worktree, "FAIL"), "x\n"); // the floor is `test ! -e FAIL`
    sh(s.worktree, "add", "FAIL");
    sh(s.worktree, "commit", "-qm", "breaks the floor");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const before = sh(root, "rev-parse", "main");
    const lines: string[] = [];
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, (l) => lines.push(l));
    expect(out.kind === "refused" && out.reason).toBe("floor");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
    expect(lines.join("\n")).toContain(`${s.change} reopened`);
    expect(claims(ws(root).db).map((c) => c.subject)).toEqual([s.change]);
  });

  test("BR-2018: taking the close commit back never drops a commit made after the check, nor local edits to the change file", () => {
    const root = project();
    const s = startNew(root, "Reopen race");
    const path = sh(s.worktree, "diff", "--name-only", "main", "HEAD");
    const closeIt = () => {
      writeFileSync(join(s.worktree, path), readFileSync(join(s.worktree, path), "utf8").replace("status: open", "status: done"));
      sh(s.worktree, "commit", "-qam", `canon: close ${s.change}`);
    };
    closeIt();
    const checked = { ok: true as const, value: sh(s.worktree, "rev-parse", "HEAD") };
    writeFileSync(join(s.worktree, "fix.txt"), "fix\n"); // the session commits a fix meanwhile
    sh(s.worktree, "add", "fix.txt");
    sh(s.worktree, "commit", "-qm", "fix");
    const fix = sh(s.worktree, "rev-parse", "HEAD");
    const lines: string[] = [];
    expect(reopen(s.worktree, { subject: s.change, path }, (l) => lines.push(l), checked)).toBe(false);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(fix);
    expect(readFileSync(join(s.worktree, "fix.txt"), "utf8")).toBe("fix\n");
    expect(lines.join("\n")).toContain("was not reopened");
    expect(lines.join("\n")).toContain("says done although it did not land");

    sh(s.worktree, "reset", "-q", "--hard", checked.value);
    writeFileSync(join(s.worktree, path), readFileSync(join(s.worktree, path), "utf8") + "\nlocal note\n");
    const dirty: string[] = [];
    expect(reopen(s.worktree, { subject: s.change, path }, (l) => dirty.push(l))).toBe(false);
    expect(dirty.join("\n")).toContain("was not reopened");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(checked.value);
    expect(readFileSync(join(s.worktree, path), "utf8")).toContain("local note");
  });

  test("BR-2018: a --finish landing that times out in the queue takes its close commit back too", async () => {
    const root = project();
    const s = startNew(root, "Timed out finish");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const out = await land(ws(s.worktree), { finish: true, timeoutMs: 0 }, quiet);
    expect(out.kind).toBe("timeout");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
  });

  test("BR-2018: --finish leaves alone a claim and handoff that another session took over during the landing", async () => {
    const root = project();
    const s = startNew(root, "Taken over");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const lines: string[] = [];
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, (l) => lines.push(l));
    await Bun.sleep(300);
    other.db.db.query("UPDATE claims SET holder = 'agent:b' WHERE subject = ?").run(s.change); // taken over after the lease ran out
    writeHandoff(other.db, { subject: s.change, worktree: s.worktree, actor: "agent:b", next: "mine now", note: null });
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
    expect(claims(other.db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
    expect(handoffs(other.db).map((h) => h.next)).toEqual(["mine now"]);
    expect(lines.join("\n")).toContain("claimed by another session now");
  });
});
