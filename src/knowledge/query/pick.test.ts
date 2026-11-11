import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { previewReview } from "../review/preview.ts";
import { project, sh, startNew, ws } from "../../work/testkit.ts";
import { parsePicks } from "./pick.ts";

// reason: these tests drive the canon CLI through spawned processes (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const BR = (n: number) => ["BR", n].join("-");
const rule = (n: number, body: string) => `---\nid: ${BR(n)}\ntitle: r${n}x\nstatus: active\nuntested: fixture\n---\n\n## 规则\n\n${body}\n\n## 例子\n\n- a → b\n`;
const readme = (name: string) => `---\ncode: [src/${name}]\n---\n# ${name}\n\n## 术语\n\n- **词**：意思\n`;
const ONE = `canon/rules/billing/${BR(1)}.md`;
const ONE_BODY = "退款时写 `refund.issued` 事件。";
const PLAIN = `Related to ${BR(1)} (references both ways, shared text and names; check they do not contradict it):`;
const FALLBACK = "; the list below is the fused ranking, nothing was picked";

/**
 * A project whose main holds BR-1 and the rules `others` (numbers) that each name it, so all of them are its
 * candidates, ranked by number; and a fake pick command whose answer, exit code and body the test sets. No model runs.
 */
function fixture(others: readonly number[], opts: { command?: boolean; extra?: string } = {}) {
  const root = project();
  const dir = mkdtempSync(join(tmpdir(), "canon-pick-"));
  const script = join(dir, "pick.sh");
  const picker = (body = `cat ${dir}/answer\n[ -f ${dir}/stderr ] && cat ${dir}/stderr >&2\nexit $(cat ${dir}/code)`) => {
    writeFileSync(script, `#!/bin/sh\ncat > ${dir}/prompt\necho run >> ${dir}/runs\n${body}\n`);
    chmodSync(script, 0o755);
  };
  picker();
  const answer = (text: string, code = 0) => {
    writeFileSync(join(dir, "answer"), text);
    writeFileSync(join(dir, "code"), String(code));
  };
  answer("[]");
  const files: Record<string, string> = { "canon/rules/billing/README.md": readme("billing"), "canon/rules/shipping/README.md": readme("shipping"), "src/billing/.keep": "", "src/shipping/.keep": "", [ONE]: rule(1, ONE_BODY) };
  for (const n of others) files[`canon/rules/shipping/${BR(n)}.md`] = rule(n, `按 ${BR(1)} 发货 ${n}。`);
  const pickLine = opts.command === false ? "" : `related_pick_command: ${JSON.stringify(script)}\n`;
  files["canon/config.yaml"] = `floor: test ! -e FAIL\ntests: []\nreview: none\n${pickLine}${opts.extra ?? ""}`;
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "rules");
  const runs = () => (existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length : 0);
  const canon = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:test" } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  /** The related-documents part of `canon context BR-1`: from the first pick line or the section's title to the next blank line. */
  const related = (cwd = root) => {
    const r = canon(cwd, "context", BR(1));
    const lines = r.out.split("\n");
    const from = lines.findIndex((l) => l.startsWith("related_pick_command:") || l.startsWith(`Related to ${BR(1)}`));
    const to = lines.findIndex((l, i) => i > from && l === "");
    return { code: r.code, lines: from < 0 ? [] : lines.slice(from, to), out: r.out };
  };
  return { root, dir, script, picker, answer, runs, canon, related, prompt: () => readFileSync(join(dir, "prompt"), "utf8") };
}

const entry = (n: number, why: string) => [`  ${BR(n)} r${n}x  (${why})`, `      按 ${BR(1)} 发货 ${n}。`];
const fused = (ns: readonly number[]) => ns.flatMap((n) => entry(n, `names ${BR(1)}`));

describe("related_pick_command picks from the fused top 50", () => {
  test("BR-2443: unset on main, canon context prints the fused section exactly and runs no command", () => {
    const f = fixture([5, 6], { command: false });
    expect(f.related().lines).toEqual([PLAIN, ...fused([5, 6])]);
    expect(f.runs()).toBe(0);
  });

  test("BR-2443: set on main, the picked ones come first with their reason, then the rest of the fused top 10, none twice", () => {
    const f = fixture([5, 6, 7]);
    f.answer(JSON.stringify([{ id: BR(7), reason: "都改\n退款事件" }]));
    const r = f.related();
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `Related to ${BR(1)} (the first 1 picked by related_pick_command from the fused top 50, then references both ways, shared text and names; check they do not contradict it):`,
      ...entry(7, `picked: 都改 退款事件; names ${BR(1)}`),
      ...fused([5, 6]),
    ]);
    expect(f.runs()).toBe(1);
    // the prompt: A's whole text, then one line per candidate in ranking order
    expect(f.prompt()).toContain(`# Document ${BR(1)}: r1x`);
    expect(f.prompt()).toContain(ONE_BODY);
    expect(f.prompt()).toContain(`- ${BR(5)} r5x: 按 ${BR(1)} 发货 5。 - a → b\n- ${BR(6)} r6x:`);
  });

  test("BR-2443: a pick beyond the fused top 10 is listed first, then the whole top 10", () => {
    const ns = Array.from({ length: 12 }, (_, i) => 10 + i);
    const f = fixture(ns);
    f.answer(JSON.stringify([BR(21)]));
    const r = f.related();
    expect(r.lines.filter((l) => /^ {2}\S/.test(l))).toHaveLength(11);
    expect(r.lines[1]).toBe(`  ${BR(21)} r21x  (picked; names ${BR(1)})`);
    expect(r.lines.slice(3)).toEqual(fused(ns.slice(0, 10)));
  });

  test("BR-2443: a list inside other text is read; a plain id string is a pick without a reason", () => {
    const f = fixture([5, 6]);
    f.answer(`Here you go: ["${BR(6)}"] done`);
    expect(f.related().lines.slice(1, 3)).toEqual(entry(6, `picked; names ${BR(1)}`));
  });

  test("BR-2443: a command set only in the worktree's own config is not run; main's is", () => {
    const f = fixture([5], { command: false });
    const s = startNew(f.root, "Pick here");
    const cfg = join(s.worktree, "canon/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}related_pick_command: ${JSON.stringify(f.script)}\n`);
    expect(f.related(s.worktree).lines).toEqual([PLAIN, ...fused([5])]);
    writeFileSync(join(s.worktree, ONE), rule(1, `${ONE_BODY}\n改了。`));
    const out = previewReview(ws(s.worktree), "guide");
    return out.then((o) => {
      expect(o.kind).toBe("off");
      expect(f.runs()).toBe(0);
    });
  });

  test("BR-2443: the edit hook and canon check never run it", () => {
    const f = fixture([5, 6]);
    f.answer(JSON.stringify([BR(6)]));
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(f.root, ONE) }, cwd: "/" });
    const hook = Bun.spawnSync(["bun", MAIN, "restatements", "--hook"], { cwd: f.root, stdout: "pipe", stderr: "pipe", stdin: Buffer.from(input), env: { ...process.env, CANON_ACTOR: "agent:test" } });
    expect(hook.stdout.toString()).toContain(`- ${BR(5)} r5x`);
    f.canon(f.root, "check");
    expect(f.runs()).toBe(0);
    expect(f.related().lines[1]).toBe(`  ${BR(6)} r6x  (picked; names ${BR(1)})`);
    expect(f.runs()).toBe(1);
  });

  test("BR-2443 BR-2358: canon work review lists the picks of main's command for each changed rule first", async () => {
    const f = fixture([5, 6]);
    f.answer(JSON.stringify([{ id: BR(6), reason: "同一事件" }]));
    const s = startNew(f.root, "Edit one");
    writeFileSync(join(s.worktree, ONE), rule(1, `${ONE_BODY}\n改了。`));
    const out = await previewReview(ws(s.worktree), "guide");
    expect(out.kind).toBe("off");
    expect(out.kind === "off" && out.related.slice(0, 3)).toEqual([
      `Related to ${BR(1)} (the first 1 picked by related_pick_command from the fused top 50, then references both ways, shared text and names; check they do not contradict it):`,
      ...entry(6, `picked: 同一事件; names ${BR(1)}`),
    ]);
    expect(f.prompt()).toContain("改了。");
  });
});

describe("the pick is cached by command and prompt", () => {
  test("BR-2444: the same command and prompt run once, in any checkout; a changed text or command runs again", () => {
    const f = fixture([5, 6]);
    f.answer(JSON.stringify([BR(6)]));
    const first = f.related();
    expect(f.related()).toEqual(first);
    expect(f.runs()).toBe(1);
    const events = ws(f.root).db.db.query<{ subject: string }, []>("SELECT subject FROM events WHERE kind = 'related.pick'").all();
    expect(events).toEqual([{ subject: BR(1) }]);
    const s = startNew(f.root, "Elsewhere");
    expect(f.related(s.worktree).lines).toEqual(first.lines);
    expect(f.runs()).toBe(1);
    writeFileSync(join(s.worktree, ONE), rule(1, `${ONE_BODY}。`));
    f.related(s.worktree);
    expect(f.runs()).toBe(2);
    writeFileSync(join(f.root, "canon/config.yaml"), readFileSync(join(f.root, "canon/config.yaml"), "utf8").replace(JSON.stringify(f.script), JSON.stringify(`${f.script} again`)));
    sh(f.root, "commit", "-qam", "another command");
    f.related();
    expect(f.runs()).toBe(3);
  });

  test("BR-2444: an empty answer is kept and said again without a run; a failure is not kept", () => {
    const f = fixture([5]);
    f.answer("[]");
    const line = `related_pick_command: picked none of the 1 candidates${FALLBACK}`;
    expect(f.related().lines[0]).toBe(line);
    expect(f.related().lines[0]).toBe(line);
    expect(f.runs()).toBe(1);
    const g = fixture([5]);
    g.answer("", 1);
    g.related();
    g.related();
    expect(g.runs()).toBe(2);
  });
});

describe("a failed pick is said in one line", () => {
  test("BR-2445: a non-zero exit says the code and stderr, lists the fused ranking, and keeps exit code 0", () => {
    const f = fixture([5, 6]);
    writeFileSync(join(f.dir, "stderr"), "quota exceeded\n");
    f.answer("", 3);
    const r = f.related();
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`related_pick_command: it exited 3: quota exceeded${FALLBACK}`, PLAIN, ...fused([5, 6])]);
  });

  test("BR-2445: a command running past related_pick_timeout_seconds is stopped and said", () => {
    const f = fixture([5], { extra: "related_pick_timeout_seconds: 1\n" });
    f.picker("sleep 30");
    const started = Date.now();
    const r = f.related();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.lines[0]).toBe(`related_pick_command: it did not finish within 1 second(s) (related_pick_timeout_seconds) and was stopped${FALLBACK}`);
    expect(r.lines.slice(1)).toEqual([PLAIN, ...fused([5])]);
  });

  test("BR-2445: an answer that is no list of ids is said with why", () => {
    const f = fixture([5]);
    f.answer("sorry, no idea");
    expect(f.related().lines[0]).toStartWith("related_pick_command: it printed no JSON list");
    const ids = new Set([BR(9)]);
    const why = (out: string) => {
      const r = parsePicks(out, ids);
      return r.ok ? "ok" : r.error.message;
    };
    expect(why(JSON.stringify({ id: BR(9) }))).toStartWith("it printed JSON that is not a list");
    expect(why("[42]")).toStartWith("item 1 of its list is neither an id");
    expect(why(JSON.stringify([{ id: BR(9), reason: 3 }]))).toStartWith("item 1 of its list has a reason that is not a string");
    expect(why("[oops]")).toStartWith("its JSON list does not parse");
    expect(why(JSON.stringify([BR(9)]))).toBe("ok");
  });

  test("BR-2445: ids not among the candidates are dropped and counted; none left lists the fused ranking", () => {
    const f = fixture([5, 6, 7, 8, 9]);
    f.answer(JSON.stringify([BR(9), BR(999)]));
    const kept = f.related().lines;
    expect(kept[0]).toBe(`related_pick_command: dropped 1 id(s) not among the 5 candidates: ${BR(999)}`);
    expect(kept[1]).toStartWith(`Related to ${BR(1)} (the first 1 picked`);
    expect(kept[2]).toBe(`  ${BR(9)} r9x  (picked; names ${BR(1)})`);
    const g = fixture([5, 6, 7, 8, 9]);
    g.answer(JSON.stringify([BR(999)]));
    expect(g.related().lines).toEqual([`related_pick_command: picked no candidate (dropped 1 id(s) not among the 5 candidates: ${BR(999)})${FALLBACK}`, PLAIN, ...fused([5, 6, 7, 8, 9])]);
  });

  test("BR-2445: a valid pick prints no such line", () => {
    const f = fixture([5]);
    f.answer(JSON.stringify([BR(5)]));
    expect(f.related().lines.some((l) => l.startsWith("related_pick_command:"))).toBe(false);
  });
});
