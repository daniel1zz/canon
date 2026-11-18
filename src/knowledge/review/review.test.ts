import { findingOf } from "./findings/findings.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { DUPLICATE_CRITERIA, RULE_CRITERIA, Slots, duplicatePrompt, onlyChangedBlock, outsideNote, reviewPrompt, runReview, standingText } from "./review.ts";

const id = (p: string, n: number) => [p, n].join("-");

function corpusOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "canon-review-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, ...readCorpus(root) };
}

const rule = (n: number, title: string, body: string) => `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: active\nuntested: fixture\n---\n${body}\n`;

/** work with subdomains work/drop (BR-2) and work/land (BR-3), billing (BR-4), one accepted and one proposed decision. */
const files = {
  "canon/rules/work/README.md": "---\ncode: [src/work]\n---\n# work\n\nOverview of work.\n",
  "canon/rules/work/drop/README.md": "# work/drop\n\nDropping.\n",
  "canon/rules/work/land/README.md": "# work/land\n\nLanding.\n",
  [`canon/rules/work/drop/${id("BR", 2)}.md`]: rule(2, "Drop archives first", "Archive before deleting."),
  [`canon/rules/work/land/${id("BR", 3)}.md`]: rule(3, "Land in order", "Queue in arrival order."),
  "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n",
  [`canon/rules/billing/${id("BR", 4)}.md`]: rule(4, "Refund window", "Refunds within 30 days."),
  [`canon/decisions/${id("D", 1)}.md`]: `---\nid: ${id("D", 1)}\ntitle: Why a queue\nstatus: accepted\n---\nBecause of ${id("BR", 3)}.\n`,
  [`canon/decisions/${id("D", 2)}.md`]: `---\nid: ${id("D", 2)}\ntitle: Maybe later\nstatus: proposed\n---\nx\n`,
};

describe("rule review of deleted documents", () => {
  test("BR-2009: a deleted rule brings the current context of its whole top-level domain", () => {
    const { root, corpus } = corpusOf(files);
    const deleted = [{ id: id("BR", 1), path: `canon/rules/work/land/${id("BR", 1)}.md`, text: rule(1, "Retry once", "Retry a failed landing once.") }];
    const prompt = reviewPrompt(root, corpus, [], { deleted });
    expect(prompt).toContain(`## ${id("BR", 1)} — deleted canon/rules/work/land/${id("BR", 1)}.md`);
    expect(prompt).toContain("# Current context for work\n");
    expect(prompt).toContain("Queue in arrival order."); // what is left in work/land
    expect(prompt).toContain("Archive before deleting."); // and its sibling subdomain
    expect(prompt).not.toContain("# Current context for billing");
  });

  test("BR-2009: a deleted decision brings the domains of the rules its text on main named; a deleted rule of a vanished domain only its text", () => {
    const { root, corpus } = corpusOf(files);
    const decision = { id: id("D", 9), path: `canon/decisions/${id("D", 9)}.md`, text: `---\nid: ${id("D", 9)}\ntitle: Old\nstatus: accepted\n---\nAbout ${id("BR", 4)}.\n` };
    const prompt = reviewPrompt(root, corpus, [], { deleted: [decision] });
    expect(prompt).toContain("# Current context for billing\n");
    expect(prompt).toContain("Refunds within 30 days.");
    expect(prompt).not.toContain("# Current context for work");

    const gone = { id: id("BR", 9), path: `canon/rules/gone/${id("BR", 9)}.md`, text: rule(9, "Gone", "Gone text.") };
    const alone = reviewPrompt(root, corpus, [], { deleted: [gone], deletedReadmes: [{ path: "canon/rules/gone/README.md", text: "# gone\n\nWhat gone covered.\n" }] });
    expect(alone).toContain("Gone text.");
    expect(alone).not.toContain("# Current context for");
    expect(alone).toContain("## deleted domain README canon/rules/gone/README.md\n\n# gone\n\nWhat gone covered.\n"); // its text on main, not only the path
  });

  test("BR-2009: a deleted rule whose domain is also changed gives that domain's context once", () => {
    const { root, corpus } = corpusOf(files);
    const changed = corpus.docs.filter((d) => d.id === id("BR", 2));
    const deleted = [{ id: id("BR", 1), path: `canon/rules/work/land/${id("BR", 1)}.md`, text: rule(1, "Retry once", "x") }];
    const prompt = reviewPrompt(root, corpus, changed, { deleted });
    expect(prompt.split("# Current context for work\n").length).toBe(2);
  });
});

describe("rule review of changed decisions", () => {
  const decision = (n: number, body: string) => `---\nid: ${id("D", n)}\ntitle: Decision ${n}\nstatus: proposed\n---\n${body}\n`;

  test("BR-2009: changed decisions bring the whole top-level domain of the rules they name, each domain once and each decision text once", () => {
    const { root, corpus } = corpusOf({
      ...files,
      [`canon/decisions/${id("D", 5)}.md`]: decision(5, `Drop rule ${id("BR", 2)} matters. Unique text five.`),
      [`canon/decisions/${id("D", 6)}.md`]: decision(6, `Land rule ${id("BR", 3)} matters. Unique text six.`),
    });
    const changed = corpus.docs.filter((d) => d.id === id("D", 5) || d.id === id("D", 6));
    const prompt = reviewPrompt(root, corpus, changed);
    expect(prompt.split("# Current context for work\n").length).toBe(2); // once, though both decisions name work rules
    expect(prompt).toContain("Archive before deleting."); // work/drop
    expect(prompt).toContain("Queue in arrival order."); // and work/land: the whole top-level domain
    expect(prompt).not.toContain("# Current context for billing");
    expect(prompt).not.toContain(`# Current context for ${id("D", 5)}`);
    expect(prompt.split("Unique text five.").length).toBe(2); // the changed text is not repeated as context
    expect(prompt.split("Unique text six.").length).toBe(2);
  });

  test("BR-2009: a changed decision that names no rule brings no domain context", () => {
    const { root, corpus } = corpusOf({ ...files, [`canon/decisions/${id("D", 5)}.md`]: decision(5, "No rule named.") });
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("D", 5)));
    expect(prompt).not.toContain("# Current context for");
    expect(prompt).toContain("No rule named.");
  });
});

describe("rule review prompt", () => {
  test("BR-2036: the prompt lists every active rule with its domain and every accepted decision, not proposed ones", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    expect(prompt).toContain(`- ${id("BR", 3)} [work/land] Land in order`);
    expect(prompt).toContain(`# Accepted decisions\n\n- ${id("D", 1)} Why a queue`);
    expect(prompt).not.toContain("Maybe later");
  });

  test("BR-2009: the instructions ask for every blocking defect and make a defect only between unchanged documents a note", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    expect(prompt).toContain("List every blocking defect you find, not only the first");
    expect(prompt).toContain("a defect only between documents this landing does not change is a `note`");
  });

  test("BR-2484: after asking for every defect, the prompt treats text that names its replacement as history and asks for each defect once", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    const every = prompt.indexOf("List every blocking defect you find");
    const history = prompt.indexOf("A passage that says, in its own line or the line just below it, that it no longer holds and names the decision or rule that replaced it");
    const once = prompt.indexOf("Give each defect once");
    expect(every).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(every);
    expect(once).toBeGreaterThan(every);
    expect(prompt).toContain("lists another in `amends:` or `supersedes:`, the later one wins where they differ");
    expect(prompt).toContain("Old text that names no replacement and is listed in no `amends:` or `supersedes:` is judged as usual.");
  });
});

describe("review command", () => {
  const answer = (out: string) => runReview(`printf '%s' '${out}'`, tmpdir(), "prompt", { timeoutMs: 60_000, kind: "land" });

  test("BR-2216: the prompt goes in on stdin; the verdict JSON may be surrounded by other text; missing findings are none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-review-cmd-"));
    const seen = join(dir, "stdin.txt");
    const r = await runReview(`cat > ${seen}; echo 'Here is my answer: {"verdict":"block","findings":["BR-1 is vague"]} done'`, dir, "the prompt text", { timeoutMs: 60_000, kind: "land" });
    expect(r).toEqual({ ok: true, value: { verdict: "block", findings: ["BR-1 is vague"] } });
    expect(await Bun.file(seen).text()).toBe("the prompt text");
    expect(await answer('{"verdict":"ok"}')).toEqual({ ok: true, value: { verdict: "ok", findings: [] } });
    await runReview(`pwd > ${join(dir, "cwd.txt")}; echo '{"verdict":"ok"}'`, dir, "p", { timeoutMs: 60_000, kind: "land" });
    expect(realpathSync((await Bun.file(join(dir, "cwd.txt")).text()).trim())).toBe(realpathSync(dir)); // run in the given directory
  });

  test("BR-2216: no JSON, JSON that does not parse, a verdict other than ok or block, or a non-zero exit is an error", async () => {
    for (const out of ["looks fine to me", '{"verdict":"ok",}', '{"verdict":"maybe","findings":[]}']) {
      const r = await answer(out);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("invalid");
    }
    const failed = await runReview("echo boom >&2; exit 3", tmpdir(), "p", { timeoutMs: 60_000, kind: "land" });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.message).toBe("review command exited 3: boom");
  });

  test("BR-2216: a non-zero exit names its reason from stdout when stderr is empty, from both when both exist, and says no output when neither does", async () => {
    const run = (cmd: string) => runReview(cmd, tmpdir(), "p", { timeoutMs: 60_000, kind: "land" }).then((r) => (!r.ok ? r.error.message : "ok"));
    expect(await run("echo 'Prompt is too long'; exit 1")).toBe("review command exited 1 (stdout): Prompt is too long");
    expect(await run("echo 'err text' >&2; echo 'out text'; exit 2")).toBe("review command exited 2 (stderr): err text; (stdout): out text");
    expect(await run("echo '  ' >&2; exit 4")).toBe("review command exited 4: no output");
    const long = await run("printf 'A%.0s' $(seq 1 100); printf 'B%.0s' $(seq 1 500); exit 1");
    expect(long).toBe(`review command exited 1 (stdout): ${"B".repeat(500)}`);
  });
});

describe("review verdict derived from the criteria findings name (BR-2367)", () => {
  const answer = (out: string) => runReview(`printf '%s' '${out}'`, tmpdir(), "prompt", { timeoutMs: 60_000, kind: "land" });
  const f = (criterion: string, text: string) => `{"criterion":"${criterion}","text":"${text}"}`;

  test("BR-2367: a finding naming a criterion blocks whatever verdict the answer states; notes alone are ok", async () => {
    const amends = "D-66 changes part of D-21 without amends";
    expect(await answer(`{"findings":[${f("amends", amends)}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: [`[amends] ${amends}`] } });
    expect(await answer(`{"verdict":"ok","findings":[${f("contradiction", "BR-1 「三天」 contradicts BR-2 「五天」")}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: ["[contradiction] BR-1 「三天」 contradicts BR-2 「五天」"] } });
    expect(await answer(`{"verdict":"block","findings":[${f("note", "style")}]}`)).toEqual({ ok: true, value: { verdict: "ok", findings: ["style"] } });
    expect(await answer(`{"findings":[${f("note", "BR-3 could be shorter")},${f("untestable", "BR-4 is vague")}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: ["BR-3 could be shorter", "[untestable] BR-4 is vague"] } });
    expect(await answer('{"findings":[]}')).toEqual({ ok: true, value: { verdict: "ok", findings: [] } });
    const wording = await answer(`{"findings":[${f("note", "n")}],"wording":{"BR-1":"wording"}}`);
    expect(wording).toEqual({ ok: true, value: { verdict: "ok", findings: ["n"], wording: { "BR-1": "wording" } } });
  });

  test("BR-2481, BR-2434: a contradiction or restatement that quotes no text is a note saying why, which is not recorded as an open finding; one that quotes, or another criterion without quotes, still blocks", async () => {
    const unquoted = "BR-1000 cites BR-956 only in the part this call shows; cannot be decided here";
    expect(await answer(`{"findings":[${f("contradiction", unquoted)}]}`)).toEqual({ ok: true, value: { verdict: "ok", findings: [`${unquoted} (canon: given as [contradiction] but quotes no text, so taken as a note)`] } });
    expect(findingOf(`${unquoted} (canon: given as [contradiction] but quotes no text, so taken as a note)`).criterion).toBe("note");
    expect(await answer(`{"findings":[${f("restatement", "未发现可判定的 restatement，\`BR-5\` 无复述")}]}`)).toEqual({ ok: true, value: { verdict: "ok", findings: ["未发现可判定的 restatement，`BR-5` 无复述 (canon: given as [restatement] but quotes no text, so taken as a note)"] } });
    expect(await answer(`{"findings":[${f("restatement", "BR-5 「三天内退款」 restates BR-4 「五天内退款」")}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: ["[restatement] BR-5 「三天内退款」 restates BR-4 「五天内退款」"] } });
    expect(await answer(`{"findings":[${f("untestable", "BR-4 says nothing about exit codes")}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: ["[untestable] BR-4 says nothing about exit codes"] } });
  });

  test("BR-2523, BR-2434, BR-2367: a blocking finding whose own text concludes there is no blocking problem is a note saying why, not an open finding; 'no conflict' followed by a problem still blocks", async () => {
    const cleared = "BR-1 要求「三天内退款」，BR-2 要求「三天内退款」，二者一致，没有矛盾。未发现阻断问题。";
    const note = `${cleared} (canon: given as [contradiction] but its own text says there is no problem, so taken as a note)`;
    expect(await answer(`{"findings":[${f("contradiction", cleared)}]}`)).toEqual({ ok: true, value: { verdict: "ok", findings: [note] } });
    expect(findingOf(note).criterion).toBe("note");
    const english = "BR-6 「按 BR-5 的半径」 agrees with BR-5; overall no   Blocking defect from the rules shown.";
    expect(await answer(`{"findings":[${f("restatement", english)}]}`)).toEqual({ ok: true, value: { verdict: "ok", findings: [`${english} (canon: given as [restatement] but its own text says there is no problem, so taken as a note)`] } });
    const real = "BR-6 「按半径排序」 orders by radius, so no conflict, but it duplicates the mapping in BR-5 「按半径排序」";
    expect(await answer(`{"findings":[${f("restatement", real)}]}`)).toEqual({ ok: true, value: { verdict: "block", findings: [`[restatement] ${real}`] } });
    const empty = mkdtempSync(join(tmpdir(), "canon-prompt-"));
    expect(reviewPrompt(empty, readCorpus(empty).corpus, [])).toContain("A remark whose conclusion is that there is no blocking problem is a `note`");
  });

  test("BR-2367: a finding without a usable criterion or text, or a string among objects, is an invalid answer that says which finding and the names", async () => {
    for (const out of [`{"findings":[${f("vague", "x")}]}`, '{"findings":[{"text":"x"}]}', `{"findings":[${f("note", "")}]}`, `{"findings":[${f("note", "a")},"b"]}`]) {
      const r = await answer(out);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("invalid");
    }
    const r = await answer(`{"findings":[${f("note", "a")},${f("vague", "x")}]}`);
    expect(!r.ok && r.error.message).toContain("finding 2");
    expect(!r.ok && r.error.message).toContain("contradiction|untestable");
  });

  test("BR-2367: an answer without findings that name a criterion is the old format: its verdict is taken as stated, and without one it is invalid", async () => {
    expect(await answer('{"verdict":"block","findings":["BR-1 is vague"]}')).toEqual({ ok: true, value: { verdict: "block", findings: ["BR-1 is vague"] } });
    expect(await answer('{"verdict":"ok","findings":["BR-1 is vague"]}')).toEqual({ ok: true, value: { verdict: "ok", findings: ["BR-1 is vague"] } });
    expect(await answer('{"verdict":"block"}')).toEqual({ ok: true, value: { verdict: "block", findings: [] } });
    for (const out of ['{"findings":["BR-1 is vague"]}', '{"verdict":"maybe","findings":[]}', "{}"]) {
      const r = await answer(out);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("invalid");
    }
  });

  test("BR-2447: the rule review prompt carries the business-overlap criterion, and only a line this landing adds can block for it", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    expect(RULE_CRITERIA).toContain("business-overlap");
    expect(prompt).toContain("`business-overlap`:");
    expect(prompt).toContain("`## 业务`");
    expect(prompt).toContain("A line this landing did not add is a `note`");
    expect(prompt).toContain("Name both business names and the domain");
  });

  test("BR-2447: the prompt names the business of a changed rule and of every rule in the domain text, and nothing for a rule without one", () => {
    const mapped = {
      ...files,
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\nMoney.\n\n## 业务\n\n- **refunds**：giving money back\n",
      [`canon/rules/billing/${id("BR", 4)}.md`]: `---\nid: ${id("BR", 4)}\ntitle: Refund window\nstatus: active\nuntested: fixture\nbusiness: refunds\n---\nRefunds within 30 days.\n`,
    };
    const { root, corpus } = corpusOf(mapped);
    const refund = corpus.docs.find((d) => d.id === id("BR", 4))!;
    const prompt = reviewPrompt(root, corpus, [refund]);
    expect(prompt).toContain("business: refunds"); // under the changed rule's heading, like a decision's supersedes/amends
    expect(prompt).toContain(`## ${id("BR", 4)} Refund window [business: refunds]`); // and in the domain's current context

    const plain = reviewPrompt(root, corpus, [corpus.docs.find((d) => d.id === id("BR", 3))!]);
    expect(plain).not.toContain("business:");
  });

  test("BR-2367: the rule review prompt lists every criterion key and the answer format; the duplicate review prompt lists duplication", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    expect(RULE_CRITERIA).toEqual(["contradiction", "untestable", "no-rejected-options", "release", "amends", "overview", "restatement", "business-overlap"]);
    for (const key of RULE_CRITERIA) expect(prompt).toContain(`\`${key}\`:`);
    expect(prompt).toContain('{"findings":[{"criterion":"contradiction"|"untestable"');
    expect(prompt).toContain("canon derives it from the keys");
    expect(prompt).not.toContain('"verdict"');
    const dup = duplicatePrompt(["CLAUDE.md"], { files: [], skills: [] }, undefined);
    for (const key of DUPLICATE_CRITERIA) expect(dup).toContain(`"criterion":"${key}"|"note"`);
    expect(dup).not.toContain('"verdict"');
  });
});

describe("duplicate review prompt", () => {
  test("BR-2217: a skill without a description, or whose front matter does not parse, is shown as such and the prompt is still built", () => {
    const { root } = corpusOf({
      "CLAUDE.md": "# Project\n",
      ".claude/skills/good/SKILL.md": "---\nname: good\ndescription: Use when testing.\n---\nbody\n",
      ".claude/skills/bare/SKILL.md": "---\nname: bare\n---\nbody\n",
      ".claude/skills/none/SKILL.md": "no front matter\n",
      ".claude/skills/broken/SKILL.md": "---\ndescription: [unclosed\n---\nbody\n",
    });
    const standing = standingText(root, ["CLAUDE.md"]);
    const prompt = duplicatePrompt(["CLAUDE.md"], standing, undefined);
    expect(prompt).toContain("- .claude/skills/good/SKILL.md: Use when testing.");
    expect(prompt).toContain("- .claude/skills/bare/SKILL.md: (no description)");
    expect(prompt).toContain("- .claude/skills/none/SKILL.md: (no description)");
    expect(prompt).toMatch(/- \.claude\/skills\/broken\/SKILL\.md: \(front matter does not parse: .+\)/);
    expect(prompt).toContain("# CLAUDE.md (instruction file, loaded whole)\n\n# Project\n");
  });
});

describe("what the rule review prompt asks of untestable and contradiction (D-115)", () => {
  const prompt = () => {
    const { root, corpus } = corpusOf(files);
    return reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)), {});
  };

  test("BR-2473: a changed rule's untested: reason reaches the prompt, so the reviewer can see how a person accepts it", () => {
    const manual = `---\nid: ${id("BR", 5)}\ntitle: Worth sharing\nstatus: active\nuntested: UNIQUE_MANUAL_ACCEPTANCE_REASON\n---\n## 规则\n\nThe end page is worth a screenshot.\n\n## 验收\n\nThe owner plays it and records yes or no.\n`;
    const { root, corpus } = corpusOf({ ...files, [`canon/rules/billing/${id("BR", 5)}.md`]: manual });
    const p = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 5)), {});
    expect(p).toContain("untested: UNIQUE_MANUAL_ACCEPTANCE_REASON");
    expect(p).toContain("The owner plays it and records yes or no.");
  });

  test("BR-2473: untestable accepts a stated way of accepting a goal, still wants a test for a claim a test can decide, and never asks to reshape a goal or invent tiers", () => {
    const p = prompt();
    expect(p).toContain("what is accepted, what evidence is handed over, and who accepts or rejects it against the goal and records it; it needs no measurable threshold.");
    expect(p).toContain("A claim a test can decide (a name not shown early, a reward not given twice) still needs a test, even beside such a goal.");
    expect(p).toContain("never ask to delete, narrow or widen a goal or commitment, nor to choose levels or tiers the text does not set.");
  });

  test("BR-2474: a contradiction quotes both passages under the same conditions with two results that cannot both hold; differing but compatible requirements and silence are not one", () => {
    const p = prompt();
    expect(p).toContain("Quote both passages and name the conditions (an input, a sequence of inputs or a state history) and the two incompatible results.");
    expect(p).toContain("Two requirements that differ but can both be met are not a contradiction, and one text saying nothing is not a contrary result; a tension you cannot show that way is a `note`.");
  });
});

describe("blocking findings outside the landing", () => {
  const changed = new Set([id("BR", 5), id("BR", 6)]);
  test("BR-2485, BR-2434: a blocking finding naming only unchanged documents becomes a note, so it is not recorded, and the verdict is derived again", () => {
    const text = `${id("D", 89)} 「核实」 vs ${id("D", 99)} 「不另跑核实」`;
    const v = onlyChangedBlock({ verdict: "block", findings: [`[contradiction] ${text}`, "a note"] }, changed);
    expect(v.verdict).toBe("ok");
    expect(v.findings).toEqual([`${text} ${outsideNote("contradiction")}`, "a note"]);
    expect(findingOf(v.findings[0]!).criterion).toBe("note");
  });

  test("BR-2485: a finding naming a changed or deleted document, naming no id, or about the overview still blocks", () => {
    const kept = [
      `[contradiction] ${id("BR", 5)} 「三天」 vs ${id("BR", 4)} 「五天」`,
      `[contradiction] ${id("BR", 6)} 「x」 vs ${id("BR", 4)} 「y」`,
      "[untestable] the rule is vague",
      `[overview] ${id("BR", 4)} 「x」 vs the overview`,
      `[business-overlap] ${id("BR", 4)} two businesses`,
    ];
    for (const f of kept) expect(onlyChangedBlock({ verdict: "block", findings: [f] }, changed)).toEqual({ verdict: "block", findings: [f] });
  });

  test("BR-2485: with no changed document that has an id, and for an answer in the old format, nothing is demoted", () => {
    const f = `[contradiction] ${id("D", 89)} 「a」 vs ${id("D", 99)} 「b」`;
    expect(onlyChangedBlock({ verdict: "block", findings: [f] }, new Set())).toEqual({ verdict: "block", findings: [f] });
    expect(onlyChangedBlock({ verdict: "block", findings: [`${id("D", 89)} is vague`] }, changed)).toEqual({ verdict: "block", findings: [`${id("D", 89)} is vague`] });
  });
});

describe("calls shared by reviews running at once", () => {
  test("BR-2487: after review_parallel is lowered below the calls running, a waiting call starts only once the running ones are within the new limit (#231)", async () => {
    const slots = new Slots(4);
    for (let i = 0; i < 4; i++) await slots.take();
    slots.resize(1);
    let started = false;
    const waiting = slots.take().then(() => (started = true));
    for (let i = 0; i < 3; i++) {
      slots.give();
      await Bun.sleep(0);
      expect(started).toBe(false);
    }
    slots.give();
    await waiting;
    expect(started).toBe(true);
  });

  test("BR-2487: a freed slot goes to the call waiting longest, and raising the size starts waiting calls at once", async () => {
    const slots = new Slots(1);
    await slots.take();
    const order: number[] = [];
    const a = slots.take().then(() => order.push(1));
    const b = slots.take().then(() => order.push(2));
    slots.resize(2);
    await a;
    expect(order).toEqual([1]);
    slots.give();
    await b;
    expect(order).toEqual([1, 2]);
  });
});
