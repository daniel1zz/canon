import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate } from "./delegate.ts";
import { start } from "../session/session.ts";
import { land } from "../land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: each case runs canon or lands; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, "../../invocation/main.ts");
const OWNER = "agent:s1";
const W1 = "agent:s7:w1";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });

function cli(cwd: string, actor: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: actor, ...env } });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
const put = (dir: string, path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
const commit = (dir: string, message = "edit") => { sh(dir, "add", "-A"); sh(dir, "commit", "-qm", message); };
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const DECISION = "---\nid: D-40\ntitle: Contract\nstatus: accepted\n---\n\n## 背景\n\nWhy.\n\n## 方案\n\n1. A contract：采用。\n2. No contract：否决。\n\n## 决定\n\nUse a contract.\n\n## 后果\n\nNone.\n";

/** A project whose main lists `profiles` as design_profiles (none when null), with a decision, a design_paths file and the owner's files. */
function fixture(profiles: string | null = "[sub-opus]") {
  const root = project(); roots.push(root);
  put(root, "canon/config.yaml", `floor: test ! -e FAIL\ntests: []\nreview: none\ndesign_paths: [docs/DESIGN.md]\n${profiles === null ? "" : `design_profiles: ${profiles}\n`}`);
  put(root, "canon/product.md", "# Product\n\nShared work.\n");
  put(root, "canon/decisions/D-40.md", DECISION);
  put(root, "docs/DESIGN.md", "# Design\n\nFirst.\n");
  put(root, "canon/backlog.md", "# Backlog\n");
  commit(root, "design");
  return root;
}
/** What the session-start hook records for a worker session (BR-2633), written directly so most cases need no host. */
function recorded(root: string, session: string, profile: string | null) {
  const w = ws(root, OWNER);
  w.db.db.query("INSERT OR IGNORE INTO worker_profiles(session, profile) VALUES (?, ?)").run(session, profile);
  w.db.close();
}
const NEW = ["work", "start", "--title", "Designed here", "--owner-gate", "none: test", "--advances", "none: test"];
const profiles = (root: string) => { const w = ws(root, OWNER); try { return w.db.db.query<{ session: string; profile: string | null }, []>("SELECT session, profile FROM worker_profiles ORDER BY session").all(); } finally { w.db.close(); } };
const eventsOf = (root: string, kind: string): Record<string, unknown>[] => { const w = ws(root, OWNER); try { return w.db.db.query<{ subject: string | null; actor: string; detail: string }, [string]>("SELECT subject, actor, detail FROM events WHERE kind = ? ORDER BY id").all(kind).map((r) => ({ subject: r.subject, actor: r.actor, ...(JSON.parse(r.detail) as Record<string, unknown>) })); } finally { w.db.close(); } };

/** A change the designer opens with `start --title`, with the sections a landing needs written and committed, as startNew does for a session. */
function opened(root: string, title: string) {
  const r = start(ws(root, W1), { title, fields: { owner_gate: "none: test", advances: "none: test" } }, quiet);
  if (!r.ok) throw new Error(r.error.message);
  const dir = join(r.value.worktree, "canon/changes");
  const file = readdirSync(dir).find((f: string) => f.startsWith(`${r.value.change}-`) || f === `${r.value.change}.md`) as string;
  const text = readFileSync(join(dir, file), "utf8");
  writeFileSync(join(dir, file), `${text.slice(0, text.indexOf("---\n", 4) + 4)}\n## 为什么\n\n${title}.\n\n## 要改什么\n\n${title}.\n\n## 教训\n\n无。\n\n## 任务\n\n- [ ] ${title}\n`);
  sh(r.value.worktree, "commit", "-q", "--amend", "--no-edit", "-a");
  return r.value;
}

const SESSION = "s7abcdef-1111-2222-3333-444455556666";
function brief(root: string, input: string | undefined, env: Record<string, string | undefined>) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CANON_ACTOR: undefined, CANON_SUBAGENT: undefined, CANON_WORKER_PROFILE: undefined, ...env };
  const p = Bun.spawnSync(["bun", CLI, "brief"], { cwd: root, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe", env: base as Record<string, string> });
  return { code: p.exitCode, text: p.stdout.toString() + p.stderr.toString() };
}
const startEvent = (session = SESSION) => JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "startup", cwd: "/x" });

test("BR-2633: the session-start hook records the profile of a worker session once; later commands, other events and sessions that are no worker write nothing", () => {
  const root = fixture();
  const worker = { CANON_SUBAGENT: "w1", CANON_WORKER_PROFILE: "sub-opus" };
  expect(brief(root, startEvent(), worker).code).toBe(0);
  expect(profiles(root)).toEqual([{ session: "agent:s7abcdef", profile: "sub-opus" }]);
  expect(eventsOf(root, "worker.profile")).toMatchObject([{ subject: "agent:s7abcdef", actor: "agent:s7abcdef:w1", session: "agent:s7abcdef", profile: "sub-opus" }]);
  // a later brief with another value, and one without the start event, change nothing
  expect(brief(root, startEvent(), { CANON_SUBAGENT: "w1", CANON_WORKER_PROFILE: "sub-sonnet" }).code).toBe(0);
  expect(brief(root, undefined, { CANON_SUBAGENT: "w1", CANON_WORKER_PROFILE: "sub-sonnet" }).code).toBe(0);
  expect(profiles(root)).toEqual([{ session: "agent:s7abcdef", profile: "sub-opus" }]);
  expect(eventsOf(root, "worker.profile")).toHaveLength(1);
  // an event that is not the start of a session, and a session that is no worker, record nothing
  expect(brief(root, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s8abcdef-0000" }), { CLAUDE_CODE_SESSION_ID: "s8abcdef-0000", ...worker }).code).toBe(0);
  expect(brief(root, startEvent("s9abcdef-0000"), { CLAUDE_CODE_SESSION_ID: "s9abcdef-0000", CANON_WORKER_PROFILE: "sub-opus" }).code).toBe(0);
  expect(profiles(root)).toEqual([{ session: "agent:s7abcdef", profile: "sub-opus" }]);
});

test("BR-2633: a worker session started without the variable is recorded as having no profile, and a later brief with the variable does not change it", () => {
  const root = fixture();
  expect(brief(root, startEvent(), { CANON_SUBAGENT: "w1" }).code).toBe(0);
  expect(profiles(root)).toEqual([{ session: "agent:s7abcdef", profile: null }]);
  expect(brief(root, startEvent(), { CANON_SUBAGENT: "w1", CANON_WORKER_PROFILE: "sub-opus" }).code).toBe(0);
  expect(profiles(root)).toEqual([{ session: "agent:s7abcdef", profile: null }]);
  expect(eventsOf(root, "worker.profile")).toMatchObject([{ profile: null }]);
});

test("BR-2633 BR-2498: a worker whose recorded profile is in main's design_profiles opens a change and a chore, claims them, and start.ok and chore.start name the profile; no delegation record is written", () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-opus");
  const r = cli(root, W1, NEW);
  expect(r.code).toBe(0);
  expect(eventsOf(root, "start.ok").some((e) => e["actor"] === W1 && e["worker_profile"] === "sub-opus")).toBe(true);
  expect(ws(root, OWNER).db.db.query("SELECT 1 FROM delegations").get()).toBeNull();
  const chore = cli(root, W1, ["chore", "start", "tidy the scripts"]);
  expect(chore.code).toBe(0);
  expect(eventsOf(root, "chore.start")).toMatchObject([{ actor: W1, worker_profile: "sub-opus" }]);
});

test("BR-2633 BR-2498: the other workers still cannot open work: another profile, no variable at the session start, the variable only in the command, no design_profiles, or a profile removed from the list", () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-sonnet");
  recorded(root, "agent:s8", null);
  expect(cli(root, "agent:s7:w1", NEW).code).toBe(1);
  expect(cli(root, "agent:s7:w1", ["chore", "start", "x"]).code).toBe(1);
  // the variable of the command's own environment is never read
  expect(cli(root, "agent:s7:w1", NEW, { CANON_WORKER_PROFILE: "sub-opus" }).code).toBe(1);
  expect(cli(root, "agent:s8:w1", NEW, { CANON_WORKER_PROFILE: "sub-opus" }).code).toBe(1);
  expect(cli(root, "agent:s9:w1", NEW, { CANON_WORKER_PROFILE: "sub-opus" }).code).toBe(1); // no record at all
  const plain = fixture(null);
  recorded(plain, "agent:s7", "sub-opus");
  expect(cli(plain, W1, NEW).code).toBe(1);
  // the list is main's: removing the profile from it stops the worker from the next command on
  const open = fixture();
  recorded(open, "agent:s7", "sub-opus");
  expect(cli(open, W1, NEW).code).toBe(0);
  put(open, "canon/config.yaml", read(open, "canon/config.yaml").replace("design_profiles: [sub-opus]\n", "design_profiles: [other]\n"));
  commit(open, "remove the profile");
  expect(cli(open, W1, ["chore", "start", "again"]).code).toBe(1);
});

test("BR-2633: a worker that adds its own profile to design_profiles on its branch gains nothing, because the list is main's", () => {
  const root = fixture("[other]");
  recorded(root, "agent:s7", "sub-opus");
  const s = startNew(root, "Worker's own", OWNER);
  put(s.worktree, "canon/config.yaml", read(s.worktree, "canon/config.yaml").replace("[other]", "[other, sub-opus]"));
  commit(s.worktree, "add myself");
  expect(cli(s.worktree, W1, NEW).code).toBe(1);
});

test("BR-2633: design_profiles that is not a list of names is a configuration error with exit 2", () => {
  const root = fixture("sub-opus");
  const r = cli(root, OWNER, ["work", "due"]);
  expect(r.code).toBe(2);
  expect(r.text).toContain("design_profiles");
});

test("BR-2633: a worker that may design takes up a change nobody works on, but not one delegated to another worker, and it cannot delegate", () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-opus");
  recorded(root, "agent:s9", "sub-opus");
  expect(cli(root, W1, NEW).code).toBe(0);
  const mine = (ws(root, OWNER).db.db.query<{ subject: string }, []>("SELECT subject FROM claims").get())!.subject;
  expect(cli(root, W1, ["work", "stop", "--reason", "partial", "--next", "resume", "--release"]).code).not.toBe(2);
  // released by its opener, a new session of the same kind takes it up
  // reason: a worker that may design is one another session launched (here CLAUDE_DELEGATE_CHILD=1, BR-2468); without that mark the start is BR-2610's implicit delegation for agent:s9
  const launched = { CLAUDE_DELEGATE_CHILD: "1" };
  const w = ws(root, OWNER);
  w.db.db.query("DELETE FROM claims WHERE subject = ?").run(mine);
  w.db.close();
  expect(cli(root, "agent:s9:w1", ["work", "start", mine], launched).code).toBe(0);
  const w2 = ws(root, OWNER);
  w2.db.db.query("DELETE FROM claims WHERE subject = ?").run(mine);
  w2.db.close();
  // the design owner delegates it to w3: a worker that may design still starts only what is delegated to its name
  const d = delegate(ws(root, OWNER), mine, "w3", [], quiet);
  if (!d.ok) throw new Error(d.error.message);
  expect(cli(root, "agent:s9:w1", ["work", "start", mine], launched).code).toBe(1);
  // and a worker never delegates, whatever its profile
  expect(cli(root, W1, ["work", "delegate", mine, "--to", "w4"]).code).toBe(2);
});

test("BR-2633 BR-2501: a worker that may design lands decisions, rules and its change file, and the landing is not refused for design; the owner's files and design_paths are still refused", async () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-opus");
  const wt = opened(root, "Designed here").worktree;
  put(wt, "canon/decisions/D-40.md", `${read(wt, "canon/decisions/D-40.md")}\nAnd one more choice.\n`);
  commit(wt, "decision");
  const ok = await land(ws(wt, W1), FAST, quiet);
  expect(ok.kind === "refused" ? `${ok.reason}: ${ok.message}` : ok.kind).toBe("landed");
  // the files only the owner may change
  for (const path of ["canon/config.yaml", "canon/product.md", "canon/backlog.md", "docs/DESIGN.md"]) {
    const next = opened(root, `Touch ${path}`);
    put(next.worktree, path, `${read(next.worktree, path)}\n# changed by a worker\n`);
    commit(next.worktree, "owner file");
    const refused = await land(ws(next.worktree, W1), FAST, quiet);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.reason).toBe("delegation");
      expect(refused.message).toContain("1. changed design");
      expect(refused.message).toContain(path);
    }
  }
}, 120_000);

test("BR-2501: a worker whose profile is not listed is refused for a decision it changes, with or without a delegation record", async () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-sonnet");
  const s = startNew(root, "Plain worker", OWNER);
  const d = delegate(ws(root, OWNER), s.change, "w1", [], quiet);
  if (!d.ok) throw new Error(d.error.message);
  const claimed = start(ws(root, W1), { change: s.change }, quiet);
  if (!claimed.ok) throw new Error(claimed.error.message);
  put(s.worktree, "canon/decisions/D-40.md", `${read(s.worktree, "canon/decisions/D-40.md")}\nOne more.\n`);
  commit(s.worktree, "decision");
  const out = await land(ws(s.worktree, W1), FAST, quiet);
  expect(out.kind === "refused" ? out.message : out.kind).toContain("1. changed design: canon/decisions/D-40.md (D-40)");
}, 60_000);

test("BR-2633 BR-2501: a delegated change keeps the design-since-delegation check for a worker that may design: designing is allowed, landing over a design that moved after the delegation is not", async () => {
  const root = fixture();
  recorded(root, "agent:s7", "sub-opus");
  const s = startNew(root, "Delegated to a designer", OWNER);
  const d = delegate(ws(root, OWNER), s.change, "w1", [], quiet);
  if (!d.ok) throw new Error(d.error.message);
  const claimed = start(ws(root, W1), { change: s.change }, quiet);
  if (!claimed.ok) throw new Error(claimed.error.message);
  put(s.worktree, "canon/decisions/D-40.md", `${read(s.worktree, "canon/decisions/D-40.md")}\nDesigned by the worker.\n`);
  commit(s.worktree, "decision");
  // the owner changes the product after delegating, without delegating again
  put(root, "canon/product.md", `${read(root, "canon/product.md")}\nA new direction.\n`);
  commit(root, "new direction");
  const out = await land(ws(s.worktree, W1), FAST, quiet);
  expect(out.kind).toBe("refused");
  if (out.kind === "refused") {
    expect(out.reason).toBe("delegation");
    expect(out.message).toContain("2. design changed since the delegation");
    expect(out.message).not.toContain("1. changed design");
  }
}, 60_000);
