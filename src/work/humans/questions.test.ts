import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { answer, ask, parseAsked, questions, recordAsked, witnessMark, type AskedRecord, type WitnessContext } from "./questions.ts";
import { project, sh, startNew, ws } from "../testkit.ts";
import { RECORD_COMMAND } from "../../install/hook.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

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

/** No session to compare with: for answers whose question-tool check is not what the test is about. */
const NO_CTX: WitnessContext = { session: null, hookInstalled: () => true };

function db(): CoordDb {
  const r = CoordDb.open(join(mkdtempSync(join(tmpdir(), "canon-next-state-")), "state.db"));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("human questions", () => {
  test("BR-2021: an agent answers only as a relay of the human's words, recorded as such; a bare agent answer is refused and recorded", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", []);
    const r = answer(d, q, "yes", "agent:x", undefined, false, NO_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid");
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(d.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'human.answer.refuse'").get()?.n).toBe(1);
    expect(answer(d, q, "yes", "human:dz", "x", true, NO_CTX).ok).toBe(false); // a human answers directly, not as a relay
    expect(answer(d, q, "yes", "agent:x", "  好的  ", false, NO_CTX).ok).toBe(true);
    const got = questions(d, "all")[0]!;
    expect([got.answer, got.answered_by, got.relayed]).toEqual(["yes", "agent:x", "好的"]);
  });

  test("BR-2021: with options a relay is recorded only as the option the human's words name; a different word, a different option or a free sentence recorded as an option is refused with exit 1 and nothing recorded", () => {
    const root = project();
    const d = ws(root).db;
    // reason: one real CLI run each for a refusal and for an acceptance (the entry point, its exit codes); the other
    // cases of the rule are the same answer() call in this process, since each CLI run costs a process start that a
    // loaded machine stretches to seconds (C-375, #126)
    for (let i = 0; i < 6; i++) ask(d, "agent:x", null, `Ship it ${i}?`, ["yes", "no"]);
    const stored = (n: number) => questions(d, "all").find((q) => q.id === n)!;
    const relay = (id: number, text: string, words: string) => answer(d, id, text, "agent:x", words, false, NO_CTX);
    const refused = (id: number, text: string, words: string) => {
      const r = relay(id, text, words);
      return r.ok ? "ok" : r.error.code;
    };
    // the human chose no in the question tool; the agent types yes
    const lie = canon(root, "agent:x", false, "human", "answer", "1", "yes", "--relayed", "no");
    expect([lie.code, stored(1).answer]).toEqual([1, null]);
    expect(refused(2, "no", "yes")).toBe("refused");
    expect(refused(3, "yes", "好的，发吧")).toBe("refused");
    expect(refusals(root)).toEqual(["option-mismatch", "option-mismatch", "option-mismatch"]);
    expect(questions(d, "pending").map((q) => q.id)).toEqual([1, 2, 3, 4, 5, 6]);
    // the same words and option are recorded, whatever the case or the spaces
    expect(canon(root, "agent:x", false, "human", "answer", "1", "no", "--relayed", "no").code).toBe(0);
    expect(refused(4, "yes", " YES ")).toBe("ok");
    expect([stored(1).answer, stored(1).relayed, stored(4).answer, stored(4).relayed]).toEqual(["no", "no", "yes", "YES"]);
    // an answered question stays 5, and a question without options keeps any relay
    expect(canon(root, "agent:x", false, "human", "answer", "1", "yes", "--relayed", "no").code).toBe(5);
    const free = ask(d, "agent:x", null, "Free?", []);
    expect(refused(free, "yes", "好的，发吧")).toBe("ok");
  });

  test("BR-2021: with options, words that name none of them are recorded exactly as said and marked in pending; an answer rewritten into an option or changed in any letter is refused", () => {
    const root = project();
    const d = ws(root).db;
    for (let i = 0; i < 4; i++) ask(d, "agent:x", null, `Ship it ${i}?`, ["yes", "no"]);
    const stored = (n: number) => questions(d, "all").find((q) => q.id === n)!;
    const code = (id: number, text: string, words: string) => {
      const r = answer(d, id, text, "agent:x", words, false, NO_CTX);
      return r.ok ? "ok" : r.error.code;
    };
    // reason: one real CLI run for the acceptance and the pending mark (the entry point); the refusals call answer() in this process (C-375, #126)
    const ok = canon(root, "agent:x", false, "human", "answer", "1", "先等 C-428 合入再发", "--relayed", "先等 C-428 合入再发");
    expect(ok.code).toBe(0);
    expect([stored(1).answer, stored(1).relayed]).toEqual(["先等 C-428 合入再发", "先等 C-428 合入再发"]);
    expect(code(2, "no", "不发")).toBe("refused"); // own words rewritten into an option
    expect(code(3, "Yes, Please", "yes, please")).toBe("refused"); // own words, a letter changed
    expect(code(4, ",", ",")).toBe("refused"); // no non-empty part: an option answer naming no option
    expect(refusals(root)).toEqual(["option-mismatch", "option-mismatch", "option-mismatch"]);
    expect(code(4, "yes", "yes")).toBe("ok");
    const pending = canon(root, "agent:x", false, "human", "pending", "--all").out;
    expect(pending).toContain("→ 先等 C-428 合入再发 (agent:x relaying the human: \"先等 C-428 合入再发\") [not one of the options]");
    expect(pending.split("\n").filter((l) => l.includes("[not one of the options]"))).toHaveLength(1);
  });

  test("BR-2021: a --multi question takes a relayed answer naming one or more of its options, each once and the same set in the words, or words naming something else recorded exactly; anything else is refused with exit 1 and nothing recorded", () => {
    const root = project();
    const d = ws(root).db;
    // reason: one real CLI run each for asking, a refusal and an acceptance; the other cases call answer() in this process (C-375, #126)
    expect(canon(root, "agent:x", false, "human", "ask", "Which?", "--multi").code).toBe(2);
    expect(questions(d, "all")).toEqual([]);
    const asked = canon(root, "agent:x", false, "human", "ask", "Which now?", "--option", "A,B,都不做", "--multi");
    expect(asked.code).toBe(0);
    expect(asked.out).toContain("multiSelect: true");
    expect(questions(d, "all")[0]?.multi).toBe(true);
    expect(canon(root, "agent:x", false, "human", "pending").out).toContain("multi-select");
    for (let i = 0; i < 4; i++) ask(d, "agent:x", null, `Which ${i}?`, ["A", "B", "都不做"], true);
    const single = ask(d, "agent:x", null, "Single?", ["A", "B"]);
    const relay = (id: number, text: string, words: string) => answer(d, id, text, "agent:x", words, false, NO_CTX);
    const code = (id: number, text: string, words: string) => {
      const r = relay(id, text, words);
      return r.ok ? "ok" : r.error.code;
    };
    const bad = canon(root, "agent:x", false, "human", "answer", "1", "A, B", "--relayed", "A");
    expect(bad.code).toBe(1); // the words name another set
    expect(questions(d, "pending").map((q) => q.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(code(2, "A, B", "A, C")).toBe("refused"); // C is the human's own words: the answer must be the words exactly
    expect(code(3, "A, A", "A, A")).toBe("refused"); // an option twice
    expect(code(4, "A, ", "A, ")).toBe("refused"); // an empty part
    const note = relay(single, "A, B", "A, B");
    expect(!note.ok && note.error.message).toContain("not asked with --multi");
    expect(refusals(root)).toEqual(["option-mismatch", "option-mismatch", "option-mismatch", "option-mismatch", "option-mismatch"]);
    expect(code(5, "A, C", "A, C")).toBe("ok"); // C is not an option: recorded as said
    const ok = canon(root, "agent:x", false, "human", "answer", "1", "A, 都不做", "--relayed", "A, 都不做");
    expect(ok.code).toBe(0);
    expect(code(2, "B, A", "a,b")).toBe("ok");
    expect(questions(d, "all").map((q) => q.answer).slice(0, 2)).toEqual(["A, 都不做", "B, A"]);
  });

  test("BR-2021 BR-2276: a multi-select relay is checked against the question tool's record, which joins the labels with commas", () => {
    const d = db();
    const q = ask(d, "agent:a", null, "Which now?", ["A", "B"], true);
    recordAsked(d, "agent:x", { session: "s1", tool_use_id: null, transcript_path: null, questions: [{ question: "Which now?", answer: "A, B", note: null }], response: null, afk_timeout_ms: null });
    expect(answer(d, q, "A, B", "agent:x", "A, B", false, { session: "s1", hookInstalled: () => true }).ok).toBe(true);
    expect(questions(d, "all")[0]?.witness).toBe("match");
  });

  test.skipIf(!Bun.which("script"))("BR-2021: a human at a terminal answers a question with options directly, whatever the option check says for a relay", () => {
    const root = project();
    expect(canon(root, "agent:x", false, "human", "ask", "Ship it?", "--option", "yes,no").code).toBe(0);
    expect(canon(root, "human:dz", true, "human", "answer", "1", "yes").code).toBe(0);
    expect(questions(ws(root).db, "all")[0]?.answer).toBe("yes");
  });

  test("BR-2276 BR-2289: without options the relay is compared with the tool's record by the words alone, so answer no with words yes is a match and shown side by side", () => {
    const d = db();
    const q = ask(d, "agent:a", null, "Ship it?", []);
    const record: AskedRecord = { session: "s1", tool_use_id: null, transcript_path: null, questions: [{ question: "Ship it?", answer: "yes", note: null }], response: null, afk_timeout_ms: null };
    recordAsked(d, "agent:s1", record);
    expect(answer(d, q, "no", "agent:x", "yes", false, { session: "s1", hookInstalled: () => true }).ok).toBe(true);
    const got = questions(d, "all")[0]!;
    expect([got.answer, got.relayed, got.witness]).toEqual(["no", "yes", "match"]);
    expect(witnessMark(got)).toContain("match Claude Code's record");
  });

  test("BR-2040: two answers racing for one question cannot both succeed", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship it?", ["yes", "no"]);
    // The first writer wins inside the transaction; the second sees the answer and is refused.
    const first = answer(d, q, "no", "human:a", undefined, true, NO_CTX);
    const second = answer(d, q, "yes", "human:b", undefined, true, NO_CTX);
    expect([first.ok, second.ok]).toEqual([true, false]);
    if (!second.ok) expect(second.error.code).toBe("conflict");
    expect(questions(d, "all")[0]!.answer).toBe("no");
  });

  test("BR-2040: a question is answered once and the answer records who gave it", () => {
    const d = db();
    const q = ask(d, "agent:a", "C-1", "Ship on Friday?", ["yes", "no"]);
    expect(questions(d, "pending").map((x) => x.id)).toEqual([q]);
    expect(answer(d, q, "no", "human:dz", undefined, true, NO_CTX).ok).toBe(true);
    const again = answer(d, q, "yes", "human:dz", undefined, true, NO_CTX);
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
  function asked(answers: Record<string, unknown>, extra: Record<string, unknown> = {}, session = SESSION) {
    const questions = Object.keys(answers).map((question) => ({ question, header: "Q", options: [{ label: "yes", description: "" }, { label: "no", description: "" }], multiSelect: false }));
    return JSON.stringify({
      session_id: session,
      transcript_path: "/x/t.jsonl",
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

  /** Runs `canon human answer --relayed` as an agent in Claude Code session `session` (none when null). */
  function relay(cwd: string, session: string | null, actor: string, id: number, text: string, words: string) {
    const env: Record<string, string | undefined> = { ...process.env, CANON_ACTOR: actor, CLAUDECODE: "1" };
    if (session === null) delete env["CLAUDE_CODE_SESSION_ID"];
    else env["CLAUDE_CODE_SESSION_ID"] = session;
    const r = Bun.spawnSync(["bun", MAIN, "human", "answer", String(id), text, "--relayed", words], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    return r.exitCode;
  }

  const kind = (root: string, k: string) =>
    ws(root).db.db.query<{ actor: string; detail: string }, [string]>("SELECT actor, detail FROM events WHERE kind = ? ORDER BY id").all(k).map((e): Record<string, unknown> => ({ actor: e.actor, ...(JSON.parse(e.detail) as Record<string, unknown>) }));
  const records = (root: string) => kind(root, "human.asked");
  const witnesses = (root: string) => questions(ws(root).db, "all").map((q) => q.witness);

  /** A project whose primary checkout has the record hook installed (BR-2274), so "no record" is not "no hook". */
  function hooked(): string {
    const root = project();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: RECORD_COMMAND }] }] } }));
    return root;
  }

  const rec = (session: string, questions: AskedRecord["questions"], response: string | null = null): AskedRecord => ({ session, tool_use_id: null, transcript_path: null, questions, response, afk_timeout_ms: null });
  const ctx = (session: string | null, hookInstalled = true): WitnessContext => ({ session, hookInstalled: () => hookInstalled });

  test("BR-2275: canon human record writes each question with its answer and note, the freeform reply, transcript path and afkTimeoutMs as a human.asked of the session's agent", () => {
    const root = project();
    const r = record(root, asked({ "Ship it?": "yes", "Which?": ["a", "b"] }, { response: "先别发", annotations: { "Ship it?": { notes: "周五再发" } }, afkTimeoutMs: 60000 }));
    expect([r.code, r.out]).toEqual([0, ""]);
    expect(records(root)).toEqual([
      {
        actor: "agent:3d606482",
        session: SESSION,
        tool_use_id: "toolu_1",
        transcript_path: "/x/t.jsonl",
        questions: [
          { question: "Ship it?", answer: "yes", note: "周五再发" },
          { question: "Which?", answer: "a, b", note: null },
        ],
        response: "先别发",
        afk_timeout_ms: 60000,
      },
    ]);
    expect(record(root, asked({ "Ship it?": "a, b" })).code).toBe(0);
    expect(records(root)[1]).toMatchObject({ questions: [{ question: "Ship it?", answer: "a, b", note: null }], response: null, afk_timeout_ms: null });
    expect(record(root, asked({ "Ship it?": "no" }), { CANON_ACTOR: "agent:89d45e3f:add88b47" }).code).toBe(0); // BR-2023: CANON_ACTOR first
    expect(records(root)[2]?.actor).toBe("agent:89d45e3f:add88b47");
    expect(record(root, asked({ "Ship it?": "no" }), { CANON_ACTOR: "human:x", CLAUDECODE: "1" }).code).toBe(2); // BR-2023: a human: actor inside Claude Code
    expect([records(root).length, kind(root, "human.asked.refuse").length]).toEqual([3, 0]);
  });

  test("BR-2275: data that is not a usable question-tool record exits 2, writes no human.asked and writes a human.asked.refuse with its reason and session", () => {
    const root = project();
    const bash = JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_response: { answers: {} } });
    const noAnswers = JSON.stringify({ session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { questions: [] } });
    const noQuestions = JSON.stringify({ session_id: SESSION, tool_name: "AskUserQuestion", tool_response: { answers: { q: "a" } } });
    const noSession = JSON.stringify({ tool_name: "AskUserQuestion", tool_response: { questions: [], answers: { q: "a" } } });
    const notString = asked({ q: 1 });
    const badResponse = asked({ q: "a" }, { response: 1 });
    const badNote = asked({ q: "a" }, { annotations: { q: { notes: true } } });
    const badAfk = asked({ q: "a" }, { afkTimeoutMs: "soon" });
    const cases: [string, string, string | null][] = [
      [bash, "not-question-tool", SESSION],
      [noAnswers, "malformed", SESSION],
      [noQuestions, "malformed", SESSION],
      [noSession, "no-session", null],
      [notString, "malformed", SESSION],
      [badResponse, "malformed", SESSION],
      [badNote, "malformed", SESSION],
      [badAfk, "malformed", SESSION],
      ["not json", "invalid-json", null],
      ["[]", "not-object", null],
    ];
    const parsed = cases.map(([input]) => parseAsked(input)).map((p) => (p.ok ? "recorded" : [p.failure.reason, p.failure.session]));
    expect(parsed).toEqual(cases.map(([, reason, session]) => [reason, session]));
    // reason: each spawn costs about half a second, so the CLI runs only one refusal with a session and one without
    const cli = record(root, bash);
    const json = record(root, "not json", { CLAUDECODE: "1" }); // no session in the data: BR-2023 inside Claude Code
    expect([cli.code, json.code]).toEqual([2, 2]);
    expect(json.err).toContain("invalid JSON");
    expect(records(root)).toEqual([]);
    expect(kind(root, "human.asked.refuse").map((e) => [e["actor"], e["reason"], e["session"]])).toEqual([
      ["agent:3d606482", "not-question-tool", SESSION],
      [expect.stringMatching(/^agent:/), "invalid-json", null],
    ]);
  });

  test("BR-2276: a relayed answer matches only a record of the same question in the same session; the same label answered to another question is not a match", () => {
    const root = hooked();
    const d = ws(root).db;
    for (const q of ["Ship it?", "Ship it?", "Delete the old data?", "Ship it?"]) ask(d, "agent:x", null, q, []);
    expect(record(root, asked({ "Ship it?": "yes" })).code).toBe(0);
    recordAsked(d, "agent:3d606482", rec(SESSION, [{ question: "Proceed?", answer: "yes", note: null }]));
    recordAsked(d, "agent:3d606482", rec("ffffffff-other", [{ question: "Ship it?", answer: "no", note: null }])); // another session's
    expect(relay(root, SESSION, "agent:3d606482", 1, "yes", " yes ")).toBe(0);
    expect(answer(d, 2, "yes", "agent:3d606482", "好的，发吧", false, ctx(SESSION)).ok).toBe(true);
    expect(answer(d, 3, "yes", "agent:3d606482", "yes", false, ctx(SESSION)).ok).toBe(true); // "yes" was the answer to Proceed?, never to this question
    expect(relay(root, SESSION, "agent:k", 4, "yes", "yes")).toBe(0); // another actor name, the same session
    expect(witnesses(root)).toEqual(["match", "differs", "unasked", "match"]);
    const witness = kind(root, "human.answer").map((e) => e["witness"]);
    expect(witness).toEqual(["match", "differs", "unasked", "match"]);
  });

  test("BR-2276: a record of the same actor in another session does not count; without a session id the relay is marked no-session", () => {
    const d = db();
    const [a, b, c] = [ask(d, "agent:a", null, "Ship it?", []), ask(d, "agent:a", null, "Ship it?", []), ask(d, "agent:a", null, "Ship it?", [])];
    recordAsked(d, "agent:x", rec("s-1", [{ question: "Ship it?", answer: "yes", note: null }]));
    expect(answer(d, a, "yes", "agent:x", "yes", false, ctx("s-2")).ok).toBe(true);
    expect(answer(d, b, "yes", "agent:x", "yes", false, ctx(null)).ok).toBe(true);
    expect(answer(d, c, "yes", "agent:x", "yes", false, ctx("s-1")).ok).toBe(true);
    expect(questions(d, "all").map((x) => x.witness)).toEqual(["no-record", "no-session", "match"]);
  });

  test("BR-2276: only this question's answer and note count, the latest record of it wins, and the freeform reply counts only when the call asked just this question", () => {
    const d = db();
    const q = [1, 2, 3, 4, 5, 6].map(() => ask(d, "agent:a", null, " Ship it? ", []));
    recordAsked(d, "agent:x", rec("s", [{ question: "Ship it?", answer: "no", note: null }, { question: "Proceed?", answer: "yes", note: "周五" }]));
    expect(answer(d, q[0]!, "yes", "agent:x", "yes", false, ctx("s")).ok).toBe(true); // Proceed?'s answer
    expect(answer(d, q[1]!, "f", "agent:x", "周五", false, ctx("s")).ok).toBe(true); // Proceed?'s note
    recordAsked(d, "agent:x", rec("s", [{ question: "Ship it?", answer: "yes", note: "周五再发" }], "先别发"));
    expect(answer(d, q[2]!, "no", "agent:x", "no", false, ctx("s")).ok).toBe(true); // only in the older record
    expect(answer(d, q[3]!, "f", "agent:x", "周五再发", false, ctx("s")).ok).toBe(true);
    expect(answer(d, q[4]!, "w", "agent:x", "先别发", false, ctx("s")).ok).toBe(true); // the reply of a one-question call
    recordAsked(d, "agent:x", rec("s", [{ question: "Ship it?", answer: "yes", note: null }, { question: "Proceed?", answer: "yes", note: null }, { question: "Merge?", answer: "yes", note: null }], "好"));
    expect(answer(d, q[5]!, "w", "agent:x", "好", false, ctx("s")).ok).toBe(true); // the reply of a three-question call belongs to none of them
    expect(questions(d, "all").map((x) => x.witness)).toEqual(["differs", "differs", "differs", "match", "match", "differs"]);
  });

  test("BR-2276: with no record of the question, a failed record, other records, a missing hook and nothing at all each get their own mark", () => {
    const d = db();
    const q = [1, 2, 3, 4].map(() => ask(d, "agent:a", null, "Ship it?", []));
    d.event("agent:x", "human.asked.refuse", null, { reason: "malformed", session: "failed" });
    recordAsked(d, "agent:x", rec("failed", [{ question: "Other?", answer: "yes", note: null }]));
    recordAsked(d, "agent:x", rec("other", [{ question: "Other?", answer: "yes", note: null }]));
    expect(answer(d, q[0]!, "yes", "agent:x", "yes", false, ctx("failed")).ok).toBe(true);
    expect(answer(d, q[1]!, "yes", "agent:x", "yes", false, ctx("other")).ok).toBe(true);
    expect(answer(d, q[2]!, "yes", "agent:x", "yes", false, ctx("empty", false)).ok).toBe(true);
    expect(answer(d, q[3]!, "yes", "agent:x", "yes", false, ctx("empty", true)).ok).toBe(true);
    expect(answer(d, ask(d, "agent:a", null, "Q?", []), "yes", "human:dz", undefined, true, ctx("other")).ok).toBe(true);
    expect(questions(d, "all").map((x) => x.witness)).toEqual(["record-failed", "unasked", "no-hook", "no-record", null]);
  });

  test("BR-2276: a D-45 record without questions is read by its answers, never by its notes", () => {
    const d = db();
    const [a, b] = [ask(d, "agent:a", null, "Ship it?", []), ask(d, "agent:a", null, "Ship it?", [])];
    d.event("agent:x", "human.asked", null, { session: "s", tool_use_id: null, answers: [{ question: "Ship it?", answer: "yes" }], response: null, notes: ["周五再发"] });
    expect(answer(d, a, "yes", "agent:x", "yes", false, ctx("s")).ok).toBe(true);
    expect(answer(d, b, "f", "agent:x", "周五再发", false, ctx("s")).ok).toBe(true);
    expect(questions(d, "all").map((x) => x.witness)).toEqual(["match", "differs"]);
  });

  test("BR-2276: through the CLI, no record hook in the primary checkout's settings is no-hook, with it no-record", () => {
    const bare = project();
    ask(ws(bare).db, "agent:x", null, "Ship it?", []);
    expect(relay(bare, SESSION, "agent:3d606482", 1, "yes", "yes")).toBe(0);
    const root = hooked();
    ask(ws(root).db, "agent:x", null, "Ship it?", []);
    expect(relay(root, SESSION, "agent:3d606482", 1, "yes", "yes")).toBe(0);
    expect([witnesses(bare), witnesses(root)]).toEqual([["no-hook"], ["no-record"]]);
  });

  test("BR-2289: pending --all shows each mark's own words after a relayed answer, D-45's none its old words, and nothing after a direct answer", () => {
    const root = hooked();
    const d = ws(root).db;
    for (let i = 0; i < 4; i++) ask(d, "agent:x", null, "Ship it?", []);
    recordAsked(d, "agent:3d606482", rec(SESSION, [{ question: "Ship it?", answer: "yes", note: null }]));
    expect(answer(d, 1, "yes", "agent:3d606482", "yes", false, ctx(SESSION)).ok).toBe(true);
    expect(answer(d, 2, "no", "agent:3d606482", "no", false, ctx(SESSION)).ok).toBe(true);
    expect(relay(root, null, "agent:3d606482", 3, "no", "no")).toBe(0);
    expect(answer(d, 4, "no", "agent:3d606482", "yes", false, ctx(SESSION)).ok).toBe(true); // the words match; the answer kept is another
    const shown = canon(root, "agent:x", false, "human", "pending", "--all").out;
    expect(shown).toContain('→ yes (agent:3d606482 relaying the human: "yes") [the human\'s words match Claude Code\'s record]');
    expect(shown).toContain('→ no (agent:3d606482 relaying the human: "no") [the human\'s words differ from Claude Code\'s record of this question]');
    expect(shown).toContain('→ no (agent:3d606482 relaying the human: "yes") [the human\'s words match Claude Code\'s record]');
    expect(shown).toContain("[no Claude Code session to check against]");
    const marks = (["record-failed", "unasked", "no-hook", "no-record", "none"] as const).map((witness) => witnessMark({ witness }));
    expect(marks).toEqual([
      " [Claude Code's record failed in this session]",
      " [this question is not in Claude Code's records of this session]",
      " [no Claude Code record: the record hook is not installed]",
      " [no Claude Code record in this session]",
      " [no matching Claude Code record]",
    ]);
    expect(witnessMark({ witness: null })).toBe("");
  });
});
