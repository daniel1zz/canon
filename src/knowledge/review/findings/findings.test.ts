import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../../../work/land/land.ts";
import { recordVerdict } from "../../../work/stats/verdict.ts";
import type { CoordDb } from "../../../work/db.ts";
import { FAST, project, reviewLandings, sh, startNew, ws } from "../../../work/testkit.ts";
import { closeFinding } from "./close.ts";
import { closeRetired, findingOf, identityOf, namedIds, openFindings, quotedSpans, recordFindings, renderFinding, type Finding } from "./findings.ts";

// Ids are built at run time so this file names no real document (canon check reads ids in test files).
const id = (prefix: string, n: number) => [prefix, n].join("-");
const BR = (n: number) => id("BR", n);
const MAIN = join(import.meta.dir, "..", "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const f = (criterion: string, text: string): Finding => ({ criterion, text });

/** Records `findings` as one review that reviewed `reviewed`, from a fresh event. */
function record(db: CoordDb, findings: readonly Finding[], reviewed: readonly string[] = [], change: string | null = id("C", 9)) {
  const event = db.event("agent:x", "review.test", change, {});
  const r = recordFindings(db, { findings, reviewed, change, event, sha: "abc123" });
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.value, event };
}

const ruleFile = (n: number, status = "active") => `---\nid: ${BR(n)}\ntitle: Rule ${n}\nstatus: ${status}\nuntested: fixture\nbusiness: x\n---\n## 规则\n\nRule ${n}.\n\n## 例子\n\n- a → b\n`;

/** A project with a billing domain holding BR-1, BR-2, BR-3 and a reviewer that answers with no findings, or `review: none`. */
function billing(review: "none" | "empty" = "none") {
  const root = project();
  const reviewer = review === "none" ? "none" : `"echo '{\\"findings\\":[]}'"`;
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${reviewer}\n`);
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  for (const n of [1, 2, 3]) writeFileSync(join(root, `canon/rules/billing/${BR(n)}.md`), ruleFile(n));
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "billing");
  return root;
}

/** Lands a change that rewrites the given rules with the given status, and runs the review after it (BR-2441). */
async function landRules(root: string, title: string, rules: readonly [number, string][]) {
  const s = startNew(root, title);
  for (const [n, status] of rules) writeFileSync(join(s.worktree, `canon/rules/billing/${BR(n)}.md`), ruleFile(n, status).replace(`Rule ${n}.`, `Rule ${n}, ${title}.`));
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  const out = await land(ws(s.worktree), FAST, () => {});
  await reviewLandings(root);
  return out;
}

describe("finding identity", () => {
  test("BR-2433: paraphrases quoting the same words with the same ids and criterion are one finding; another criterion or quote is another", () => {
    const a = f("contradiction", `${BR(1)} 的「退款三天内到账」和 ${BR(2)} 的「退款七天内到账」矛盾`);
    const b = f("contradiction", `${BR(2)} 写「退款七天内到账」，与 ${BR(1)} 的「退款三天内到账」冲突`);
    expect(identityOf(a)).toBe(identityOf(b));
    expect(identityOf(f("restatement", a.text))).not.toBe(identityOf(a));
    expect(identityOf(f("contradiction", b.text.replace("七天", "五天")))).not.toBe(identityOf(a));
    // Quote marks and id order do not matter.
    expect(identityOf(f("contradiction", `${BR(1)} 和 ${BR(2)} 的“三天”矛盾`))).toBe(identityOf(f("contradiction", `${BR(2)}、${BR(1)} 互相矛盾：「三天」`)));
  });

  test("BR-2433: spans holding only ids quote nothing; with no quote the whole squashed text counts; ids match whole", () => {
    expect(quotedSpans(`\`${BR(1)}\` 和 \`${BR(2)}, ${BR(3)}\` 矛盾`)).toEqual([]);
    expect(quotedSpans("「 a   b 」 and `x` and “”")).toEqual(["a b", "x"]);
    expect(identityOf(f("contradiction", `\`${BR(1)}\` 和 \`${BR(2)}\` 矛盾`))).not.toBe(identityOf(f("contradiction", `${BR(1)} 与 ${BR(2)} 矛盾`)));
    expect(identityOf(f("untestable", `  ${BR(1)} 写得   太含糊`))).toBe(identityOf(f("untestable", `${BR(1)} 写得 太含糊`)));
    expect(namedIds(`${BR(201)} 和 ${id("D", 3)}、${id("R", 2)} 与 X${BR(5)}`)).toEqual([BR(201), id("D", 3), id("R", 2)]);
    expect(identityOf(f("untestable", `${BR(1)} vague`)).split(" ")[1]).toBe(BR(1));
  });

  test("BR-2433: a stored finding's criterion is the bracketed criterion name, otherwise note", () => {
    expect(findingOf(`[contradiction] ${BR(1)} x`)).toEqual({ criterion: "contradiction", text: `${BR(1)} x` });
    expect(findingOf("[duplication] twice")).toEqual({ criterion: "duplication", text: "twice" });
    expect(findingOf("措辞可以更短")).toEqual({ criterion: "note", text: "措辞可以更短" });
    expect(findingOf("[nonsense] x")).toEqual({ criterion: "note", text: "[nonsense] x" });
  });
});

describe("recording findings", () => {
  test("BR-2434: a blocking finding attaches to every document it names, reviewed or not; one naming none to the reviewed ones; notes are skipped", () => {
    const db = ws(project()).db;
    const r = record(db, [f("contradiction", `${BR(1)} 和 ${BR(7)} 的「三天」矛盾`), f("untestable", "「尽快」无法测试"), f("note", "措辞可以更短")], [BR(2), BR(1)]);
    expect(r.opened.length).toBe(2);
    const open = openFindings(db);
    expect(open.map((x) => [x.criterion, x.docs])).toEqual([
      ["contradiction", [BR(1), BR(7)]],
      ["untestable", [BR(1), BR(2)]],
    ]);
    expect(open[0]).toMatchObject({ change: id("C", 9), event: r.event, sha: "abc123", ids: [BR(1), BR(7)] });
    expect(openFindings(db, [BR(7)]).map((x) => x.criterion)).toEqual(["contradiction"]);
    expect(openFindings(db, [BR(3)])).toEqual([]);
  });

  test("BR-2434: the same identity is recorded once while open, with new documents added; after it closes it is recorded anew", () => {
    const db = ws(project()).db;
    const first = record(db, [f("untestable", "「尽快」无法测试")], [BR(1)]);
    const again = record(db, [f("untestable", "「尽快」这个词无法测试")], [BR(2)]);
    expect(again.opened).toEqual([]);
    expect(again.existing).toEqual(first.opened);
    expect(openFindings(db).map((x) => x.docs)).toEqual([[BR(1), BR(2)]]);
    expect(closeRetired(db, new Set([BR(1), BR(2)]), again.event)).toEqual([...first.opened]);
    const third = record(db, [f("untestable", "「尽快」无法测试")], [BR(1)]);
    expect(third.opened.length).toBe(1);
    expect(third.opened[0]).not.toBe(first.opened[0]);
  });

  test("BR-2434: a finding that names nothing in a review of nothing fails and the batch records nothing", () => {
    const db = ws(project()).db;
    const event = db.event("agent:x", "review.test", null, {});
    const r = recordFindings(db, { findings: [f("contradiction", `${BR(1)} x`), f("untestable", "vague")], reviewed: [], change: null, event, sha: null });
    expect(r.ok).toBe(false);
    expect(openFindings(db)).toEqual([]);
  });
});

describe("closing findings", () => {
  test("BR-2435: a landing that retires a named rule closes the finding; one that only edits it does not; one naming none closes when all its documents are retired", async () => {
    const root = billing();
    const db = ws(root).db;
    const named = record(db, [f("contradiction", `${BR(1)} 和 ${BR(2)} 的「三天」矛盾`)]).opened[0]!;
    const unnamed = record(db, [f("untestable", "「尽快」无法测试")], [BR(2), BR(3)]).opened[0]!;
    const edited = await landRules(root, "Edit", [[1, "active"]]);
    expect(edited.kind).toBe("landed");
    expect(openFindings(ws(root).db).map((x) => x.id)).toEqual([named, unnamed]);
    const retired = await landRules(root, "Retire", [[2, "retired"]]);
    expect(retired.kind).toBe("landed");
    expect(openFindings(ws(root).db).map((x) => x.id)).toEqual([unnamed]);
    const row = ws(root).db.db.query<{ closed_how: string; closed_event: number; kind: string }, [number]>("SELECT closed_how, closed_event, (SELECT kind FROM events WHERE id = closed_event) AS kind FROM review_findings WHERE id = ?").get(named)!;
    expect(row).toEqual({ closed_how: "retired", closed_event: row.closed_event, kind: "land.ok" });
    const both = await landRules(root, "Retire three", [[3, "retired"]]);
    expect(both.kind).toBe("landed");
    expect(openFindings(ws(root).db)).toEqual([]);
  });

  test("BR-2435: superseded decisions close the findings naming them; other ids do not", () => {
    const db = ws(project()).db;
    const a = record(db, [f("amends", `${id("D", 3)} 改了「范围」`)]).opened[0]!;
    const b = record(db, [f("amends", `${id("D", 4)} 改了「范围」`)]).opened[0]!;
    const event = db.event("agent:x", "land.ok", null, {});
    expect(closeRetired(db, new Set([id("D", 3)]), event)).toEqual([a]);
    expect(openFindings(db).map((x) => x.id)).toEqual([b]);
  });

  test("BR-2438: a human spurious verdict closes the open finding of the same identity; real, an agent's refused verdict, or another identity does not", () => {
    const root = project();
    const db = ws(root).db;
    const text = `[contradiction] ${BR(1)} 的「三天」和 ${BR(2)} 矛盾`;
    const block = db.event("agent:x", "review.block", id("C", 4), { findings: ["措辞", text, `[contradiction] ${BR(1)} 的「五天」和 ${BR(2)} 矛盾`], commit: "abc" });
    const open = record(db, [findingOf(`[contradiction] ${BR(2)} 写的「三天」与 ${BR(1)} 冲突`)]).opened[0]!;
    expect(recordVerdict(db, "agent:b", String(block), "2", "spurious", "no").ok).toBe(false);
    expect(recordVerdict(db, "human:alice", String(block), "3", "spurious", "other quote").ok).toBe(true);
    const later = db.event("agent:x", "review.block", id("C", 5), { findings: [text], commit: "def" });
    expect(recordVerdict(db, "human:bob", String(later), "1", "real", "it is real").ok).toBe(true);
    expect(openFindings(db).map((x) => x.id)).toEqual([open]);
    expect(recordVerdict(db, "human:alice", String(block), "2", "spurious", "the scopes differ").ok).toBe(true);
    expect(openFindings(db)).toEqual([]);
    const row = db.db.query<{ closed_how: string; kind: string }, [number]>("SELECT closed_how, (SELECT kind FROM events WHERE id = closed_event) AS kind FROM review_findings WHERE id = ?").get(open)!;
    expect(row).toEqual({ closed_how: "spurious", kind: "review.verdict" });
  });

  test("BR-2434: a later review that does not mention an open finding leaves it open", async () => {
    const root = billing("empty");
    const open = record(ws(root).db, [f("contradiction", `${BR(1)} 和 ${BR(2)} 的「三天」矛盾`)]).opened[0]!;
    expect((await landRules(root, "Quiet review", [[1, "active"]])).kind).toBe("landed");
    expect(ws(root).db.db.query("SELECT 1 FROM events WHERE kind = 'review.ok'").get()).not.toBeNull();
    expect(openFindings(ws(root).db).map((x) => x.id)).toEqual([open]);
  });
});

describe("canon finding close (BR-2453)", () => {
  /** billing with open finding #n on BR-1 and BR-2, recorded at main's commit; `edit` commits a change to BR-1 on main afterwards. */
  function opened() {
    const root = billing();
    const db = ws(root).db;
    const event = db.event("agent:x", "review.block", id("C", 9), {});
    const r = recordFindings(db, { findings: [f("contradiction", `${BR(1)} 和 ${BR(2)} 的「三天」矛盾`)], reviewed: [], change: id("C", 9), event, sha: sh(root, "rev-parse", "main") });
    if (!r.ok) throw new Error(r.error.message);
    const commit = (file: string, text: string) => {
      writeFileSync(join(root, file), text);
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", file);
      return sh(root, "rev-parse", "HEAD");
    };
    return { root, db, n: r.value.opened[0]!, commit };
  }
  const input = (root: string, n: number | string, more: { fixed?: string; spurious?: string; reason?: string }) => ({ cwd: root, main: "main", actor: "agent:test", id: String(n), reason: "why", ...more });
  const row = (db: CoordDb, n: number) => db.db.query<{ closed_how: string | null; closed_event: number | null }, [number]>("SELECT closed_how, closed_event FROM review_findings WHERE id = ?").get(n)!;

  test("BR-2453: --fixed with a later commit on main that changed a document it is attached to closes it with a finding.close event; again is a conflict", () => {
    const { root, db, n, commit } = opened();
    const fix = commit(`canon/rules/billing/${BR(1)}.md`, ruleFile(1).replace("Rule 1.", "Rule 1, only overseas."));
    const c = closeFinding(db, input(root, n, { fixed: fix.slice(0, 9), reason: "narrowed" }));
    expect(c.ok && c.value).toEqual({ id: n, how: "fixed", by: fix });
    const ev = db.db.query<{ id: number; subject: string; actor: string; detail: string }, []>("SELECT id, subject, actor, detail FROM events WHERE kind = 'finding.close'").get()!;
    expect(JSON.parse(ev.detail)).toEqual({ finding: n, how: "fixed", commit: fix, reason: "narrowed" });
    expect([ev.subject, ev.actor]).toEqual([id("C", 9), "agent:test"]);
    expect(row(db, n)).toEqual({ closed_how: "fixed", closed_event: ev.id });
    const again = closeFinding(db, input(root, n, { fixed: fix }));
    expect(!again.ok && again.error.code).toBe("conflict");
    expect(!again.ok && again.error.message).toContain("fixed");
  });

  test("BR-2453: --fixed refuses the commit the review saw, one that changes none of its documents, and one not on main", () => {
    const { root, db, n, commit } = opened();
    const seen = closeFinding(db, input(root, n, { fixed: "main" }));
    expect(!seen.ok && [seen.error.code, seen.error.message.includes("must come after")]).toEqual(["refused", true]);
    const code = commit("src/billing/a.ts", "x\n");
    const other = closeFinding(db, input(root, n, { fixed: code }));
    expect(!other.ok && [other.error.code, other.error.message.includes("changes none")]).toEqual(["refused", true]);
    sh(root, "checkout", "-qb", "side");
    const off = commit(`canon/rules/billing/${BR(2)}.md`, ruleFile(2).replace("Rule 2.", "Rule 2, side."));
    sh(root, "checkout", "-q", "main");
    const offMain = closeFinding(db, input(root, n, { fixed: off }));
    expect(!offMain.ok && [offMain.error.code, offMain.error.message.includes("not on main")]).toEqual(["refused", true]);
    expect(row(db, n).closed_how).toBeNull();
  });

  test("BR-2453: an overview finding also accepts a fix or a quote in canon/architecture.md; other criteria do not", () => {
    const root = billing();
    const db = ws(root).db;
    const event = db.event("agent:x", "review.block", id("C", 9), {});
    const r = recordFindings(db, {
      findings: [f("overview", `总览和 ${BR(1)} 矛盾`), f("contradiction", `${BR(2)} 和总览矛盾`)],
      reviewed: [], change: id("C", 9), event, sha: sh(root, "rev-parse", "main"),
    });
    if (!r.ok) throw new Error(r.error.message);
    const [over, contra] = r.value.opened;
    const commit = (file: string, text: string) => {
      writeFileSync(join(root, file), text);
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", file);
      return sh(root, "rev-parse", "HEAD");
    };
    const fix = commit("canon/architecture.md", "# 总览\n\n主 checkout 签出 main，细节见规则。\n");
    const refused = closeFinding(db, input(root, contra!, { fixed: fix, reason: "overview only counts for overview findings" }));
    expect(!refused.ok && [refused.error.code, refused.error.message.includes("changes none")]).toEqual(["refused", true]);
    const closed = closeFinding(db, input(root, over!, { fixed: fix, reason: "the overview now matches the rule" }));
    expect(closed.ok && closed.value).toEqual({ id: over!, how: "fixed", by: fix });
    const quoted = closeFinding(db, input(root, contra!, { spurious: "主 checkout 签出 main，细节见规则。", reason: "quote is only in the overview" }));
    expect(!quoted.ok && quoted.error.code).toBe("refused");
    const r2 = recordFindings(db, {
      findings: [f("overview", `总览和 ${BR(3)} 矛盾`)],
      reviewed: [], change: id("C", 9), event: db.event("agent:x", "review.block", id("C", 9), {}), sha: sh(root, "rev-parse", "main"),
    });
    if (!r2.ok) throw new Error(r2.error.message);
    const over2 = r2.value.opened[0]!;
    const byQuote = closeFinding(db, input(root, over2, { spurious: "主 checkout 签出 main，细节见规则。", reason: "the overview already says so" }));
    expect(byQuote.ok && byQuote.value).toEqual({ id: over2, how: "spurious", by: "canon/architecture.md" });
  });

  test("BR-2453: --spurious closes with a quote of 8 or more characters found word for word in one of its documents on main, across a line break; 7 or not there is refused", () => {
    const { root, db, n, commit } = opened();
    commit(`canon/rules/billing/${BR(2)}.md`, ruleFile(2).replace("Rule 2.", "本规则只适用于\n海外订单的退款。"));
    const short = closeFinding(db, input(root, n, { spurious: "海外订单的退款" }));
    expect(!short.ok && short.error.code).toBe("refused");
    const absent = closeFinding(db, input(root, n, { spurious: "的「三天」矛盾，确实如此" }));
    expect(!absent.ok && [absent.error.code, absent.error.message.includes(`${BR(1)}, ${BR(2)}`)]).toEqual(["refused", true]);
    const c = closeFinding(db, input(root, n, { spurious: "海外订单的退款。" }));
    expect(c.ok && c.value).toEqual({ id: n, how: "spurious", by: BR(2) });
    expect(row(db, n).closed_how).toBe("spurious");
  });

  test("BR-2453: usage errors exit 2, an unknown finding or commit 3, a closed one 5; an agent may close one, #n works as n, and the line says how", () => {
    const { root, n, commit } = opened();
    expect(canon(root, "finding", "close", "0", "--fixed", "main", "--reason", "x").code).toBe(2);
    expect(canon(root, "finding", "close", String(n), "--reason", "x").code).toBe(2);
    expect(canon(root, "finding", "close", String(n), "--fixed", "main", "--spurious", "Rule 1 text", "--reason", "x").code).toBe(2);
    expect(canon(root, "finding", "close", String(n), "--fixed", "main", "--reason", "  ").code).toBe(2);
    expect(canon(root, "finding", "close", "99", "--fixed", "main", "--reason", "x").code).toBe(3);
    expect(canon(root, "finding", "close", String(n), "--fixed", "nosuchref", "--reason", "x").code).toBe(3);
    const fix = commit(`canon/rules/billing/${BR(1)}.md`, ruleFile(1).replace("Rule 1.", "Rule 1, fixed."));
    const done = canon(root, "finding", "close", `#${n}`, "--fixed", fix, "--reason", "x");
    expect([done.code, done.out.trim()]).toEqual([0, `closed review finding #${n}: fixed by ${fix.slice(0, 9)}`]);
    expect(canon(root, "finding", "close", String(n), "--fixed", fix, "--reason", "x").code).toBe(5);
  });
});

describe("showing findings", () => {
  test("BR-2436: canon context lists each open finding once with criterion, ids, text, change and age; closed ones and none give no section", () => {
    const root = billing();
    expect(canon(root, "context", "billing").out).not.toContain("Open review findings");
    const db = ws(root).db;
    const first = record(db, [f("contradiction", `${BR(1)} 和 ${BR(7)} 的「三天」矛盾`)]).opened[0]!;
    record(db, [f("untestable", "「尽快」无法测试")], [BR(1), BR(2)], null);
    const today = new Date().toISOString().slice(0, 10);
    const out = canon(root, "context", "billing").out;
    expect(out).toContain("# Open review findings\n\nSettle each now: fixed, canon finding close <n> --fixed <commit> --reason \"<why>\";");
    expect(out).toContain(`- #${first} [contradiction] ${BR(1)}, ${BR(7)}: ${BR(1)} 和 ${BR(7)} 的「三天」矛盾 (${id("C", 9)}, opened ${today}, 0 days ago)`);
    expect(out.match(/\[untestable\] -: 「尽快」无法测试 \(opened \d{4}-\d{2}-\d{2}, 0 days ago\)/g)?.length).toBe(1);
    // BR-7 lives in another domain; asked about directly, it shows the finding too.
    mkdirSync(join(root, "canon/rules/shipping"), { recursive: true });
    writeFileSync(join(root, "canon/rules/shipping/README.md"), "---\ncode: [src/shipping]\n---\n# shipping\n\nParcels.\n");
    writeFileSync(join(root, `canon/rules/shipping/${BR(7)}.md`), ruleFile(7));
    expect(canon(root, "context", BR(7)).out).toContain(`- #${first} [contradiction]`);
    db.db.query("UPDATE review_findings SET closed_at = 'x', closed_how = 'spurious' WHERE criterion = 'untestable'").run();
    expect(canon(root, "context", "billing").out).not.toContain("[untestable]");
    db.db.query("UPDATE review_findings SET closed_at = 'x', closed_how = 'spurious'").run();
    expect(canon(root, "context", "billing").out).not.toContain("Open review findings");
  });

  test("BR-2436: the age is whole days since recording, one day singular", () => {
    const base = { id: 1, identity: "x", criterion: "untestable", ids: [], docs: [BR(1)], text: "t", change: null, event: 1, sha: null, openedAt: "2026-11-01T10:00:00.000Z" };
    expect(renderFinding(base, new Date("2026-11-04T09:00:00.000Z"))).toBe("#1 [untestable] -: t (opened 2026-11-01, 2 days ago)");
    expect(renderFinding(base, new Date("2026-11-04T10:00:00.000Z"))).toBe("#1 [untestable] -: t (opened 2026-11-01, 3 days ago)");
    expect(renderFinding(base, new Date("2026-11-02T10:00:00.000Z"))).toBe("#1 [untestable] -: t (opened 2026-11-01, 1 day ago)");
  });

  test("BR-2437: brief in a change worktree lists the findings on the documents the change names; elsewhere a count, none no line", () => {
    const root = billing();
    expect(canon(root, "brief").out).not.toContain("open review finding");
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    const change = (n: number, body: string, extra = "") => writeFileSync(join(root, `canon/changes/${id("C", n)}.md`), `---\nid: ${id("C", n)}\ntitle: Change ${n}\nstatus: open\n${extra}---\n\n## 为什么\n\n${body}\n\n## 要改什么\n\nx.\n\n## 任务\n\n- [ ] x\n`);
    change(2, "x.", `rules: [${BR(1)}]\n`);
    change(3, `\`${BR(1)}\` only as an example.`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "changes");
    const db = ws(root).db;
    const one = record(db, [f("contradiction", `${BR(1)} 和 ${BR(7)} 的「三天」矛盾`)]).opened[0]!;
    record(db, [f("untestable", "「尽快」无法测试")], [BR(1)]);
    const wt = (c: string) => canon(root, "work", "start", c).out.match(/cd (.+)/)![1]!.trim();
    const inChange = canon(wt(id("C", 2)), "brief").out;
    expect(inChange).toContain(`Open review finding #${one} [contradiction] ${BR(1)}, ${BR(7)}: `);
    expect(inChange.match(/Open review finding #/g)?.length).toBe(2);
    expect(inChange).not.toContain("open review finding(s)");
    expect(canon(wt(id("C", 3)), "brief").out).not.toContain("Open review finding");
    expect(canon(root, "brief").out).toContain("2 open review finding(s) on 2 document(s): canon context <id> lists them");
  });
});
