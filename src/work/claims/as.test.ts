import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

// reason: these tests drive the real command line (`bun src/invocation/main.ts`) the way a Claude Code session does: CLAUDECODE=1 and a session id, no CANON_ACTOR (BR-2023, D-62).
const CLI = join(import.meta.dir, "../../invocation/main.ts");
const SESSION = "s1abcdef-0000";
const S = "agent:s1abcdef";
const TIMED = 30_000;

async function canon(cwd: string, env: Record<string, string>, ...args: string[]) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PID: undefined, ...env };
  delete base["CANON_ACTOR"];
  if (env["CANON_ACTOR"]) base["CANON_ACTOR"] = env["CANON_ACTOR"];
  if (env["CLAUDECODE"] === "") delete base["CLAUDECODE"];
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: base as Record<string, string> });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const db = (root: string) => {
  const r = CoordDb.open(CoordDb.pathFor(root).ok ? (CoordDb.pathFor(root) as { ok: true; value: string }).value : "", root);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const holderOf = (root: string, change: string) => db(root).db.query<{ holder: string }, [string]>("SELECT holder FROM claims WHERE subject = ?").get(change)?.holder;
const events = (root: string, kind: string) => db(root).db.query<{ actor: string; subject: string | null; detail: string; worktree: string | null }, [string]>("SELECT actor, subject, detail, worktree FROM events WHERE kind = ? ORDER BY id").all(kind);

/** A repo with C-1 started by the subagent `abc`; returns the root and the change's worktree. */
async function claimedBy(name: string | undefined) {
  const root = project();
  const r = await canon(root, {}, "work", "start", "--title", "Sub work", ...(name ? ["--as", name] : []));
  expect(r.code).toBe(0);
  const id = r.out.match(/(C-\d+) →/)?.[1] ?? "C-1";
  const wt = join(root + ".worktrees", id);
  return { root, id, wt };
}

describe("--as makes the actor agent:<session>:<name> (BR-2023)", () => {
  test("BR-2023: start --as abc claims as agent:<session>:abc; without --as the actor is agent:<session>", async () => {
    const a = await claimedBy("abc");
    expect(holderOf(a.root, a.id)).toBe(`${S}:abc`);
    const b = await claimedBy(undefined);
    expect(holderOf(b.root, b.id)).toBe(S);
  });

  test("BR-2023: a bad name, --as with CANON_ACTOR, and --as outside Claude Code exit 2 and write nothing", async () => {
    const root = project();
    const noState = () => expect(existsSync(CoordDb.pathFor(root).ok ? (CoordDb.pathFor(root) as { ok: true; value: string }).value : "")).toBe(false);
    for (const bad of ["a b", "", "a:b", "a/b"]) {
      const r = await canon(root, {}, "work", "start", "--title", "X", "--as", bad);
      expect([bad, r.code]).toEqual([bad, 2]);
    }
    noState();
    const both = await canon(root, { CANON_ACTOR: "agent:x:y" }, "work", "start", "--title", "X", "--as", "abc");
    expect(both.code).toBe(2);
    expect(both.err).toContain("CANON_ACTOR");
    const outside = await canon(root, { CLAUDECODE: "" }, "work", "start", "--title", "X", "--as", "abc");
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("Claude Code");
    noState();
    expect(sh(root, "worktree", "list")).not.toContain("worktrees");
  });

  test("BR-2023: stop, land and drop take --as too; the claim's holder and the handoff name the subagent", async () => {
    const { root, id, wt } = await claimedBy("abc");
    const stop = await canon(wt, {}, "work", "stop", "--next", "x", "--as", "abc");
    expect(stop.code).toBe(0);
    expect(db(root).db.query<{ actor: string }, [string]>("SELECT actor FROM handoffs WHERE subject = ?").get(id)?.actor).toBe(`${S}:abc`);
    const drop = await canon(root, {}, "work", "drop", id, "--as", "abc");
    expect(drop.err).not.toContain("no option --as");
  }, TIMED);
});

describe("a claim held by a subagent refuses the main session and other subagents (BR-2011, BR-2104)", () => {
  test("BR-2011: the main session starting a change its subagent holds is refused with the take hint; after release the subagent starts it", async () => {
    const { root, id } = await claimedBy("abc");
    const r = await canon(root, {}, "work", "start", id);
    expect(r.code).toBe(5);
    expect(r.err).toContain(`canon work take ${id} --from abc`);
    expect(r.err).not.toContain("cd ");
    expect(holderOf(root, id)).toBe(`${S}:abc`);
  });

  test("BR-2011: a change the main session released is started by a subagent with --as, in the same worktree", async () => {
    const root = project();
    const first = await canon(root, {}, "work", "start", "--title", "Handed");
    const id = first.out.match(/(C-\d+) →/)![1]!;
    const wt = join(root + ".worktrees", id);
    expect((await canon(wt, {}, "work", "stop", "--release", "--next", "go on")).code).toBe(0);
    const r = await canon(root, {}, "work", "start", id, "--as", "abc");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`cd [^\\n]*/${id}\\n`));
    expect(sh(root, "worktree", "list").split("\n").filter((l) => l.includes(wt.split("/").pop()!))).toHaveLength(1);
    expect(holderOf(root, id)).toBe(`${S}:abc`);
  });

  test("BR-2104: the main session's land and stop in a subagent's worktree exit 5; one call that first cds in is refused too; the claim stays", async () => {
    const { root, id, wt } = await claimedBy("abc");
    const land = await canon(wt, {}, "work", "land", "--finish");
    expect(land.code).toBe(5);
    expect(land.err).toContain(`canon work take ${id} --from abc`);
    expect(land.err).toContain("do not work in this worktree unless you are that subagent");
    const stop = await canon(wt, {}, "work", "stop", "--release", "--next", "x");
    expect(stop.code).toBe(5);
    const p = Bun.spawnSync(["sh", "-c", `cd ${wt} && bun ${CLI} work stop --next x`], { cwd: root, env: { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CANON_ACTOR: "" } as Record<string, string> });
    expect(p.exitCode).toBe(5);
    expect(holderOf(root, id)).toBe(`${S}:abc`);
    expect(db(root).db.query("SELECT 1 FROM handoffs WHERE subject = ?").get(id)).toBeNull();
    expect(events(root, "claim.refuse").filter((e) => e.actor === S).length).toBe(3);
    expect(sh(root, "log", "main", "--oneline")).not.toContain(id);
  }, TIMED);

  test("BR-2104: another subagent is refused; the holding subagent renews with --as and without it is refused", async () => {
    const { root, id, wt } = await claimedBy("abc");
    expect((await canon(wt, {}, "work", "stop", "--next", "x", "--as", "def")).code).toBe(5);
    expect((await canon(wt, {}, "work", "stop", "--next", "x", "--as", "abc")).code).toBe(0);
    expect((await canon(wt, {}, "work", "land")).code).toBe(5); // forgot --as: now agent:<session>
    expect(holderOf(root, id)).toBe(`${S}:abc`);
  }, TIMED);

  test("BR-2104: a claim recorded without a name is held by the session: another agent of it may stop, a subagent with --as is refused", async () => {
    const { root, id, wt } = await claimedBy(undefined);
    expect((await canon(wt, {}, "work", "stop", "--next", "x")).code).toBe(0);
    expect(holderOf(root, id)).toBe(S);
    const r = await canon(wt, {}, "work", "land", "--as", "abc");
    expect(r.code).toBe(5);
    expect(holderOf(root, id)).toBe(S);
  }, TIMED);
});

describe("canon work take (BR-2336)", () => {
  test("BR-2336: the main session takes over its subagent's claim, a claim.handover is recorded, and it can land there", async () => {
    const root = project();
    const s = startNew(root, "Taken", `${S}:abc`);
    expect(holderOf(root, s.change)).toBe(`${S}:abc`);
    const r = await canon(root, {}, "work", "take", s.change, "--from", "abc");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`cd ${s.worktree}`);
    expect(holderOf(root, s.change)).toBe(S);
    const ev = events(root, "claim.handover");
    expect(ev.length).toBe(1);
    expect([ev[0]!.actor, ev[0]!.subject, JSON.parse(ev[0]!.detail)]).toEqual([S, s.change, { from: "abc", by: "main-session", worktree: s.worktree }]);
    expect(events(root, "claim.take").length).toBe(1); // only the start: handover is not claim.take
    expect((await canon(s.worktree, {}, "work", "stop", "--next", "go on")).code).toBe(0);
    expect((await canon(s.worktree, {}, "work", "land", "--finish")).code).toBe(0);
  }, TIMED);

  test("BR-2336: an expired claim is taken over too; the subagent's later land is refused", async () => {
    const root = project();
    const s = startNew(root, "Expired", `${S}:abc`);
    db(root).db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run("2020-01-01T00:00:00.000Z", s.change);
    expect((await canon(root, {}, "work", "take", s.change, "--from", "abc")).code).toBe(0);
    const later = await canon(s.worktree, {}, "work", "land", "--as", "abc");
    expect(later.code).toBe(5);
    expect(holderOf(root, s.change)).toBe(S);
  }, TIMED);

  test("BR-2336: a wrong --from, another session's subagent, a session-level holder and no claim exit 5 and change nothing", async () => {
    const root = project();
    const s = startNew(root, "Refused", `${S}:abc`);
    const wrong = await canon(root, {}, "work", "take", s.change, "--from", "xyz");
    expect(wrong.code).toBe(5);
    expect(wrong.err).toContain(`${S}:abc`);
    expect(holderOf(root, s.change)).toBe(`${S}:abc`);
    expect(events(root, "claim.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["handover"]);
    const other = startNew(root, "Other session", "agent:s2zzzzzz:abc");
    expect((await canon(root, {}, "work", "take", other.change, "--from", "abc")).code).toBe(5);
    expect(holderOf(root, other.change)).toBe("agent:s2zzzzzz:abc");
    const own = startNew(root, "Session level", S);
    const sameLevel = await canon(root, {}, "work", "take", own.change, "--from", "abc");
    expect(sameLevel.code).toBe(5);
    expect((await canon(root, {}, "work", "take", "C-99", "--from", "abc")).code).toBe(5);
    expect(events(root, "claim.handover")).toEqual([]);
  }, TIMED);

  test("BR-2336: --as, a bad --from, and a run outside Claude Code exit 2 and write nothing", async () => {
    const root = project();
    const s = startNew(root, "Usage", `${S}:abc`);
    const before = db(root).db.query("SELECT COUNT(*) AS n FROM events").get();
    expect((await canon(root, {}, "work", "take", s.change, "--from", "abc", "--as", "abc")).code).toBe(2);
    expect((await canon(root, {}, "work", "take", s.change, "--from", "a b")).code).toBe(2);
    expect((await canon(root, {}, "work", "take", s.change)).code).toBe(2);
    expect((await canon(root, { CLAUDECODE: "" }, "work", "take", s.change, "--from", "abc")).code).toBe(2);
    expect((await canon(root, { CANON_ACTOR: "agent:x:y" }, "work", "take", s.change, "--from", "abc")).code).toBe(2);
    expect(db(root).db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
    expect(holderOf(root, s.change)).toBe(`${S}:abc`);
  }, TIMED);
});

describe("events keep the subagent's name and worktree (BR-2131)", () => {
  test("BR-2131: a landing with --as records the named actor and the worktree", async () => {
    const root = project();
    const s = startNew(root, "Lands", `${S}:abc`);
    const r = await canon(s.worktree, {}, "work", "land", "--finish", "--as", "abc");
    expect(r.code).toBe(0);
    const ok = events(root, "land.ok");
    expect([ok[0]!.actor, ok[0]!.worktree]).toEqual([`${S}:abc`, s.worktree]);
    expect(holderOf(root, s.change)).toBeUndefined();
  }, TIMED);
});
