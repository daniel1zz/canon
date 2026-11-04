import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { answer, ask, questions, recordAsked, witnessMark } from "./questions.ts";
import { project, sh, startNew, ws } from "../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");

/** Runs the canon CLI as `actor` outside Claude Code; `tty` gives it a terminal through script(1). */
function canon(cwd: string, actor: string, tty: boolean, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor };
  delete env["CLAUDECODE"]; // reason: inside Claude Code a human: CANON_ACTOR is refused (BR-2023)
  const cmd = ["bun", MAIN, ...args];
  const argv = !tty ? cmd : process.platform === "darwin" ? ["script", "-q", "/dev/null", ...cmd] : ["script", "-qec", cmd.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const refusals = (root: string) =>
  ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'human.answer.refuse' ORDER BY id").all().map((e) => (JSON.parse(e.detail) as { reason: string }).reason);

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-next-state-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("human questions", () => {
  test("BR-2021: an agent answers only as a relay of the human's words, recorded as such; a bare agent answer is refused and recorded", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", ["yes", "no"]);
    const r = answer(d, q, "yes", "agent:x", undefined, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid");
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(d.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'human.answer.refuse'").get()?.n).toBe(1);
    expect(answer(d, q, "yes", "human:dz", "x", true).ok).toBe(false); // a human answers directly, not as a relay
    expect(answer(d, q, "yes", "agent:x", "  好的  ", false).ok).toBe(true);
    const got = questions(d, "all")[0]!;
    expect([got.answer, got.answered_by, got.relayed]).toEqual(["yes", "agent:x", "好的"]);
  });

  test("BR-2040: two answers racing for one question cannot both succeed", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", ["yes", "no"]);
    // The first writer wins inside the transaction; the second sees the answer and is refused.
    const first = answer(d, q, "no", "human:a", undefined, true);
    const second = answer(d, q, "yes", "human:b", undefined, true);
    expect([first.ok, second.ok]).toEqual([true, false]);
    if (!second.ok) expect(second.error.code).toBe("conflict");
    expect(questions(d, "all")[0]!.answer).toBe("no");
  });

  test("BR-2040: a question is answered once and the answer records who gave it", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship on Friday?", ["yes", "no"]);
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(answer(d, q, "no", "human:dz", undefined, true).ok).toBe(true);
    const again = answer(d, q, "yes", "human:dz", undefined, true);
    expect(again.ok).toBe(false);
    expect(questions(d, "pending")).toEqual([]);
    expect(questions(d, "all")[0]?.answered_by).toBe("human:dz");
  });

  test("BR-2021 BR-2026: through the CLI every refused answer exits 2 and writes a human.answer.refuse with its own reason", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?").code).toBe(0);
    const agent = canon(root, "agent:x", false, "human", "answer", "1", "yes");
    expect(agent.code).toBe(2); // issue #57: refused before answer() ran, so no event was written
    expect(agent.out).toContain("--relayed");
    expect(canon(root, "human:dz", false, "human", "answer", "1", "yes").code).toBe(2);
    expect(canon(root, "human:dz", false, "human", "answer", "1", "yes", "--relayed", "").code).toBe(2); // issue #56
    expect(canon(root, "agent:x", false, "human", "answer", "1", "yes", "--relayed", "  ").code).toBe(2);
    expect(refusals(root)).toEqual(["not-human-no-relay", "no-tty", "human-relayed", "not-human-no-relay"]);
    expect(questions(ws(root).db, "pending").map((q) => q.id)).toEqual([1]);
  });

  test.skipIf(!Bun.which("script"))("BR-2021: a human at a terminal answers directly and is shown as the answerer; with --relayed, even empty, it is refused", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?").code).toBe(0);
    expect(canon(root, "human:dz", true, "human", "answer", "1", "yes", "--relayed", "好").code).toBe(2);
    expect(canon(root, "human:dz", true, "human", "answer", "1", "yes", "--relayed", "").code).toBe(2);
    expect(refusals(root)).toEqual(["human-relayed", "human-relayed"]);
    expect(canon(root, "human:dz", true, "human", "answer", "1", "yes").code).toBe(0);
    expect(canon(root, "agent:x", false, "human", "pending", "--all").out).toContain("→ yes (human:dz)");
  });

  test("BR-2040 BR-2026: a second answer exits 5 with reason answered, an unknown question exits 3 with reason not-found; both write human.answer.refuse", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?").code).toBe(0);
    expect(canon(root, "agent:x", false, "human", "answer", "1", "yes", "--relayed", "发吧").code).toBe(0);
    expect(canon(root, "agent:y", false, "human", "answer", "1", "no", "--relayed", "算了").code).toBe(5);
    expect(canon(root, "agent:y", false, "human", "answer", "9", "no", "--relayed", "算了").code).toBe(3);
    expect(refusals(root)).toEqual(["answered", "not-found"]);
    expect(questions(ws(root).db, "all")[0]?.answer).toBe("yes");
  });

  test("BR-2040 BR-2022: an id that is not a number is a usage error: exit 2, no human.answer.refuse, the question stays unanswered", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?").code).toBe(0);
    for (const id of ["abc", "1.5", "-1"]) expect([id, canon(root, "agent:x", false, "human", "answer", id, "yes", "--relayed", "好").code]).toEqual([id, 2]);
    expect(refusals(root)).toEqual([]);
    expect(questions(ws(root).db, "pending").map((q) => q.id)).toEqual([1]);
  });

  test("BR-2021 BR-2040: a bare agent answer to an unknown or an answered question is refused for the way it answers first: exit 2, not 3 or 5", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?").code).toBe(0);
    expect(canon(root, "agent:x", false, "human", "answer", "9", "yes").code).toBe(2);
    expect(canon(root, "agent:x", false, "human", "answer", "1", "yes", "--relayed", "发吧").code).toBe(0);
    expect(canon(root, "agent:x", false, "human", "answer", "1", "no").code).toBe(2);
    expect(refusals(root)).toEqual(["not-human-no-relay", "not-human-no-relay"]);
    expect(questions(ws(root).db, "all")[0]?.answer).toBe("yes");
  });
});

describe("asking with --change", () => {
  const asked = (root: string) => ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'human.ask'").get()?.n;

  test("BR-2075: --change naming no change exits 3 and records nothing; a change on main, in any case, gets the question", () => {
    const root = project();
    const none = canon(root, "agent:x", false, "human", "ask", "Q?", "--change", "C-999");
    expect(none.code).toBe(3);
    expect(none.out).toContain("C-999");
    expect(questions(ws(root).db, "all")).toEqual([]);
    expect(asked(root)).toBe(0);
    const s = startNew(root, "Asked about");
    expect(canon(root, "agent:x", false, "human", "ask", "On its branch?", "--change", s.change).code).toBe(0); // only on its change branch
    expect(questions(ws(root).db, "all").map((q) => q.subject)).toEqual([s.change]);
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-50.md"), "---\nid: C-50\ntitle: On main\nstatus: open\n---\n## 为什么\n\nx\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "a change on main");
    expect(canon(root, "agent:x", false, "human", "ask", "Lower?", "--change", "c-50").code).toBe(0);
    expect(questions(ws(root).db, "all").map((q) => q.subject)).toEqual([s.change, "C-50"]);
  });

  test("BR-2075: without --change a question in a worktree whose claim expired still goes to that worktree's change", () => {
    const root = project();
    const s = startNew(root, "Expired here");
    ws(root).db.db.query("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(canon(s.worktree, "agent:x", false, "human", "ask", "Still?").code).toBe(0);
    expect(questions(ws(root).db, "all").map((q) => q.subject)).toEqual([s.change]);
  });
});

describe("Claude Code's record of the question tool", () => {
  const SESSION = "3d606482-8b99-44b9-8de2-3011fd029842";

  /** PostToolUse data for AskUserQuestion, shaped as Claude Code's hooks and AskUserQuestionOutput document it. */
  function asked(answers: Record<string, string>, extra: Record<string, unknown> = {}, session = SESSION) {
    const questions = Object.keys(answers).map((question) => ({ question, header: "Q", options: [{ label: "yes", description: "" }, { label: "no", description: "" }], multiSelect: false }));
    return JSON.stringify({
      session_id: session,
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions },
      tool_response: { questions, answers, ...extra },
    });
  }

  /** Runs `canon human record` with `input` on stdin, as the hook does. */
  function record(cwd: string, input: string, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
    if (!extraEnv["CANON_ACTOR"]) delete env["CANON_ACTOR"];
    const r = Bun.spawnSync(["bun", MAIN, "human", "record"], { cwd, stdout: "pipe", stderr: "pipe", stdin: new TextEncoder().encode(input), env });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  const records = (root: string) =>
    ws(root).db.db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM events WHERE kind = 'human.asked' ORDER BY id").all().map((e): Record<string, unknown> => ({ actor: e.actor, ...(JSON.parse(e.detail) as Record<string, unknown>) }));

  test("BR-2275: canon human record writes the questions and the human's answers, freeform reply and notes as a human.asked of the session's agent", () => {
    const root = project();
    const r = record(root, asked({ "Ship it?": "yes" }, { response: "先别发", annotations: { "Ship it?": { notes: "周五再发" } } }));
    expect([r.code, r.out]).toEqual([0, ""]);
    expect(records(root)).toEqual([{ actor: "agent:3d606482", session: SESSION, tool_use_id: "toolu_1", answers: [{ question: "Ship it?", answer: "yes" }], response: "先别发", notes: ["周五再发"] }]);
    expect(record(root, asked({ "Which?": "a, b" })).code).toBe(0);
    expect(records(root)[1]).toMatchObject({ answers: [{ question: "Which?", answer: "a, b" }], response: null, notes: [] });
    expect(record(root, asked({ "Ship it?": "no" }), { CANON_ACTOR: "agent:89d45e3f:add88b47" }).code).toBe(0); // BR-2023: CANON_ACTOR first
    expect(records(root)[2]?.actor).toBe("agent:89d45e3f:add88b47");
  });

  test("BR-2275: data that is not the question tool's is refused with 2 and nothing is recorded", () => {
    const root = project();
    const bash = JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_response: { answers: {} } });
    const noAnswers = JSON.stringify({ session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { questions: [] } });
    const noSession = JSON.stringify({ tool_name: "AskUserQuestion", tool_response: { answers: { q: "a" } } });
    const notString = JSON.stringify({ session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { answers: { q: 1 } } });
    const badResponse = asked({ q: "a" }, { response: 1 });
    const badNote = asked({ q: "a" }, { annotations: { q: { notes: true } } });
    for (const input of [bash, noAnswers, noSession, notString, badResponse, badNote, "not json", "[]"]) expect([input, record(root, input).code]).toEqual([input, 2]);
    expect(record(root, "not json").err).toContain("invalid JSON");
    expect(records(root)).toEqual([]);
  });

  test("BR-2276: a relayed answer is checked against the latest record of the same agent only, and pending --all shows the mark", () => {
    const root = project();
    for (let i = 0; i < 4; i++) expect(canon(root, "agent:x", false, "human", "ask", `Q${i}?`).code).toBe(0);
    const d = ws(root).db;
    expect(answer(d, 1, "yes", "agent:3d606482", "nothing yet", false).ok).toBe(true); // no record at all
    expect(record(root, asked({ "Ship it?": "yes" })).code).toBe(0);
    expect(record(root, asked({ "Ship it?": "no" }, {}, "ffffffff-other")).code).toBe(0); // another session's
    expect(answer(d, 2, "yes", "agent:3d606482", " yes ", false).ok).toBe(true);
    expect(answer(d, 3, "yes", "agent:3d606482", "好的，发吧", false).ok).toBe(true);
    expect(answer(d, 4, "no", "agent:3d606482", "no", false).ok).toBe(true); // "no" is only in the other session's record
    expect(questions(d, "all").map((q) => q.witness)).toEqual(["none", "match", "none", "none"]);
    expect(questions(d, "all")[1]?.relayed).toBe("yes"); // saved trimmed (BR-2021)
    const witness = d.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'human.answer' ORDER BY id").all().map((e) => (JSON.parse(e.detail) as { witness: string }).witness);
    expect(witness).toEqual(["none", "match", "none", "none"]);
    const shown = canon(root, "agent:x", false, "human", "pending", "--all").out;
    expect(shown).toContain('→ yes (agent:3d606482 relaying the human: "yes") [matches Claude Code\'s record]');
    expect(shown).toContain('→ yes (agent:3d606482 relaying the human: "好的，发吧") [no matching Claude Code record]');
  });

  test("BR-2276: only the latest record counts; its freeform reply and notes match too; a direct human answer gets no mark", () => {
    const d = db();
    const q = [1, 2, 3, 4].map((i) => ask(d, "agent:a", null, `Q${i}?`, []));
    recordAsked(d, "agent:x", { session: "x", tool_use_id: null, answers: [{ question: "Ship it?", answer: "yes" }], response: null, notes: [] });
    recordAsked(d, "agent:x", { session: "x", tool_use_id: null, answers: [{ question: "Ship it?", answer: "no" }], response: " 先别发 ", notes: ["周五再发"] });
    expect(answer(d, q[0]!, "yes", "agent:x", "yes", false).ok).toBe(true);
    expect(answer(d, q[1]!, "wait", "agent:x", "先别发", false).ok).toBe(true);
    expect(answer(d, q[2]!, "friday", "agent:x", "周五再发", false).ok).toBe(true);
    expect(answer(d, q[3]!, "yes", "human:dz", undefined, true).ok).toBe(true);
    const all = questions(d, "all");
    expect(all.map((x) => x.witness)).toEqual(["none", "match", "match", null]);
    expect(witnessMark(all[3]!)).toBe("");
    recordAsked(d, "agent:k", { session: "x", tool_use_id: null, answers: [{ question: "Ship it?", answer: "yes" }], response: null, notes: [] });
    const [k1, k2] = [ask(d, "agent:a", null, "Q5?", []), ask(d, "agent:a", null, "Q6?", [])];
    expect(answer(d, k1, "yes", "agent:3d606482", "yes", false).ok).toBe(true); // recorded as agent:k, relayed as someone else
    expect(answer(d, k2, "yes", "agent:k", "yes", false).ok).toBe(true);
    expect(questions(d, "all").slice(4).map((x) => x.witness)).toEqual(["none", "match"]);
  });
});
