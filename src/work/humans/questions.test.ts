import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { answer, ask, questions } from "./questions.ts";
import { project, ws } from "../testkit.ts";

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
});
