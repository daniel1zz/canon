import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { parseAnswer, reviewCalls, reviewPrompt, reviewPrompts, runReviews } from "./review.ts";

const id = (p: string, n: number) => [p, n].join("-");
const KB = 1024;
const size = (s: string) => Buffer.byteLength(s);

const rule = (n: number, title: string, body: string) => `---\nid: ${id("BR", n)}\ntitle: ${title}\nstatus: active\nuntested: fixture\n---\n## 规则\n\n${body}\n`;
/** A body of about `kb` KB that names its rule, so a prompt can be searched for it. */
const fat = (tag: string, kb: number) => `${tag} ${"x".repeat(kb * KB)}`;

function corpusOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "canon-budget-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return { root, ...readCorpus(root) };
}

/** Domain `big` with subdomains `big/a` (BR-1, BR-2, and the short BR-6) and `big/b` (BR-3, BR-4), each rule `kb` KB; a small domain `small` (BR-5). */
function bigDomain(kb: number) {
  return corpusOf({
    "canon/rules/big/README.md": "---\ncode: [src/big]\n---\n# big\n\nTop README of big.\n",
    "canon/rules/big/a/README.md": "# big/a\n\nSub A.\n",
    "canon/rules/big/b/README.md": "# big/b\n\nSub B.\n",
    [`canon/rules/big/a/${id("BR", 1)}.md`]: rule(1, "A one", fat("TEXT-1", kb)),
    [`canon/rules/big/a/${id("BR", 2)}.md`]: rule(2, "A two", fat("TEXT-2", kb)),
    [`canon/rules/big/b/${id("BR", 3)}.md`]: rule(3, "B three", fat("TEXT-3", kb)),
    [`canon/rules/big/b/${id("BR", 4)}.md`]: rule(4, "B four", fat("TEXT-4", kb)),
    "canon/rules/small/README.md": "---\ncode: [src/small]\n---\n# small\n\nSmall.\n",
    [`canon/rules/big/a/${id("BR", 6)}.md`]: rule(6, "A six", "SMALL-6 short."),
    [`canon/rules/small/${id("BR", 5)}.md`]: rule(5, "Small five", "Short text."),
    [`canon/decisions/${id("D", 1)}.md`]: `---\nid: ${id("D", 1)}\ntitle: Accepted choice\nstatus: accepted\n---\nAbout ${id("BR", 5)}.\n`,
  });
}

const TITLES: Record<number, string> = { 1: "A one", 2: "A two", 3: "B three", 4: "B four" };
const changedRule = (corpus: ReturnType<typeof bigDomain>["corpus"], n: number) => corpus.docs.filter((d) => d.id === id("BR", n));
const prompts = (r: ReturnType<typeof reviewPrompts>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("rule review prompt budget", () => {
  test("BR-2359: a prompt that fits the budget is one call, byte for byte the prompt without a budget", () => {
    const { root, corpus } = bigDomain(1);
    const changed = changedRule(corpus, 5);
    const whole = reviewPrompt(root, corpus, changed);
    expect(size(whole)).toBeLessThan(250 * KB);
    expect(prompts(reviewPrompts(root, corpus, changed, {}, 250 * KB))).toEqual([whole]);
    expect(whole).not.toContain("split into");
  });

  test("BR-2009 BR-2359: a prompt over the budget is split by subdomain; every call carries the changed rule, the index and the decisions, and none is over the budget", () => {
    const { root, corpus } = bigDomain(30); // 4 rules of 30 KB: 120 KB of big
    const changed = changedRule(corpus, 6);
    const budget = 80 * KB;
    expect(size(reviewPrompt(root, corpus, changed))).toBeGreaterThan(budget);
    const calls = prompts(reviewPrompts(root, corpus, changed, {}, budget));
    expect(calls.length).toBeGreaterThan(1);
    for (const [i, p] of calls.entries()) {
      expect(size(p)).toBeLessThanOrEqual(budget);
      expect(p).toContain("SMALL-6"); // the changed rule, in # Changed documents
      expect(p).toContain(`- ${id("BR", 5)} [small] Small five`); // the index
      expect(p).toContain(`- ${id("D", 1)} Accepted choice`);
      expect(p).toContain(`this is call ${i + 1} of ${calls.length}`);
      expect(p).toContain("never block because a rule or domain text is not shown");
    }
    // each subdomain's rules are whole in one call (they fit together), and together the calls show every rule of the domain
    const shown = (n: number) => calls.filter((p) => p.includes(`\n## ${id("BR", n)} ${TITLES[n]}\n`));
    for (const n of [1, 2, 3, 4]) expect(shown(n)).toHaveLength(1);
    const withA = calls.find((p) => p.includes(`\n## ${id("BR", 2)} A two\n`))!;
    expect(withA).toContain(`\n## ${id("BR", 1)} A one\n`);
    expect(withA).toContain("# Domain: big/a"); // its own README
    expect(withA).toContain("# Domain: big "); // and the enclosing domain's
  });

  test("BR-2359: a subdomain that does not fit a call even alone is packed one rule at a time", () => {
    const { root, corpus } = bigDomain(30);
    const budget = 50 * KB; // big/a holds 60 KB of rules, so it goes rule by rule
    const calls = prompts(reviewPrompts(root, corpus, changedRule(corpus, 6), {}, budget));
    for (const p of calls) expect(size(p)).toBeLessThanOrEqual(budget);
    for (const n of [1, 2, 3, 4]) expect(calls.filter((p) => p.includes(`\n## ${id("BR", n)} ${TITLES[n]}\n`))).toHaveLength(1);
  });

  test("BR-2359: the wording judgements are asked in the first call only", () => {
    const { root, corpus } = bigDomain(30);
    const wording = [{ id: id("BR", 6), title: "A six", before: "old", after: "new", examples: "- a → b" }];
    const calls = prompts(reviewPrompts(root, corpus, changedRule(corpus, 6), { wording }, 80 * KB));
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toContain("# Wording judgements");
    expect(calls[0]).toContain('"wording":{');
    for (const p of calls.slice(1)) {
      expect(p).not.toContain("# Wording judgements");
      expect(p).not.toContain('"wording":{');
    }
  });

  test("BR-2359: a split into ten or more calls never has a call over the budget, whatever the budget (#160)", () => {
    // 24 subdomains of 10 KB each: the call count has two digits, and the note of "call 10 of 12" is longer than the one of "call 1 of 2"
    const files: Record<string, string> = {
      "canon/rules/wide/README.md": "---\ncode: [src/wide]\n---\n# wide\n\nTop.\n",
      [`canon/rules/wide/${id("BR", 99)}.md`]: rule(99, "Wide changed", "CHANGED-99 short."),
    };
    for (let n = 1; n <= 24; n++) {
      files[`canon/rules/wide/s${n}/README.md`] = `# wide/s${n}\n\nSub ${n}.\n`;
      files[`canon/rules/wide/s${n}/${id("BR", n)}.md`] = rule(n, `Sub rule ${n}`, fat(`TEXT-${n}`, 10));
    }
    const { root, corpus } = corpusOf(files);
    const changed = corpus.docs.filter((d) => d.id === id("BR", 99));
    // a budget that holds two pieces per call: measure the real size of such a call, then try every budget within 200 bytes of it,
    // so the packing ends within a few bytes of the budget for some of them
    const probe = prompts(reviewPrompts(root, corpus, changed, {}, 30 * KB));
    const target = Math.max(...probe.map(size));
    let long = 0;
    for (let budget = target - 200; budget <= target + 200; budget++) {
      const calls = prompts(reviewPrompts(root, corpus, changed, {}, budget));
      if (calls.length >= 10) long++;
      for (const p of calls) if (size(p) > budget) throw new Error(`budget ${budget}: a call of ${calls.length} is ${size(p)} bytes`);
    }
    expect(long).toBeGreaterThan(300);
  });

  const refusal = (r: ReturnType<typeof reviewPrompts>) => {
    if (r.ok) throw new Error("expected a refusal");
    return r.error.message;
  };

  test("BR-2359: changed documents that are the large part: the refusal gives the part sizes and says to land smaller changes", () => {
    const { root, corpus } = bigDomain(30);
    const huge = changedRule(corpus, 1); // BR-1 is 30 KB and travels in every call
    const msg = refusal(reviewPrompts(root, corpus, huge, {}, 20 * KB));
    expect(msg).toMatch(/cannot be made smaller than \d+ KB .*review_max_prompt_kb = 20 KB/);
    expect(msg).toMatch(/changed documents 3\d KB, review instructions \+ rule index \+ accepted decision titles \d KB, domain text 0 KB/);
    expect(msg).toContain("land the changed documents in several smaller changes");
    expect(msg).not.toContain("cannot help");
  });

  test("BR-2359: a domain rule that cannot fit with a small change: the refusal says splitting the change cannot help and names the budget and the domain split", () => {
    const { root, corpus } = bigDomain(30);
    const msg = refusal(reviewPrompts(root, corpus, changedRule(corpus, 6), {}, 25 * KB)); // every rule is 30 KB
    expect(msg).toContain("review_max_prompt_kb = 25 KB");
    expect(msg).toMatch(/changed documents 1 KB, .*domain text 3\d KB/);
    expect(msg).toContain("splitting the change cannot help");
    expect(msg).toMatch(/raise review_max_prompt_kb in canon\/config.yaml to at least 3\d KB/);
    expect(msg).toContain("canon rule domain big/a/<name>");
    expect(msg).not.toContain("several smaller changes");
  });

  test("BR-2359: a top domain README that cannot fit: the refusal names its domain, says shortening the README and that a subdomain split does not shrink it", () => {
    const corpus = corpusOf({
      "canon/rules/wide/README.md": `---\ncode: [src/wide]\n---\n# wide\n\n${"y".repeat(40 * KB)}\n`,
      "canon/rules/wide/sub/README.md": "# wide/sub\n\nSub.\n",
      [`canon/rules/wide/sub/${id("BR", 7)}.md`]: rule(7, "Sub seven", "Short."),
    });
    const msg = refusal(reviewPrompts(corpus.root, corpus.corpus, corpus.corpus.docs.filter((d) => d.id === id("BR", 7)), {}, 20 * KB));
    expect(msg).toContain("the README of wide");
    expect(msg).toContain("splitting the change cannot help");
    expect(msg).toContain("raise review_max_prompt_kb");
    expect(msg).toContain("shorten the README of wide");
    expect(msg).toContain("does not make them smaller");
    expect(msg).not.toContain("canon rule domain");
  });

  test("BR-2359: a subdomain README that cannot fit: the refusal names the subdomain and suggests splitting it", () => {
    const corpus = corpusOf({
      "canon/rules/wide/README.md": "---\ncode: [src/wide]\n---\n# wide\n\nShort.\n",
      "canon/rules/wide/sub/README.md": `# wide/sub\n\n${"y".repeat(40 * KB)}\n`,
      [`canon/rules/wide/sub/${id("BR", 7)}.md`]: rule(7, "Sub seven", "Short."),
    });
    const msg = refusal(reviewPrompts(corpus.root, corpus.corpus, corpus.corpus.docs.filter((d) => d.id === id("BR", 7)), {}, 20 * KB));
    expect(msg).toContain("splitting the change cannot help");
    expect(msg).toContain("canon rule domain wide/sub/<name>");
    expect(msg).not.toContain("shorten the README");
  });

  test("BR-2359: a top README made large by its decision list, with short rules: the refusal says shortening the README, no subdomain split", () => {
    const files: Record<string, string> = {
      "canon/rules/listed/README.md": "---\ncode: [src/listed]\n---\n# listed\n\nShort.\n",
      [`canon/rules/listed/${id("BR", 1)}.md`]: rule(1, "Listed one", "Short."),
    };
    for (let n = 1; n <= 200; n++) files[`canon/decisions/${id("D", n)}.md`] = `---\nid: ${id("D", n)}\ntitle: ${"d".repeat(120)} ${n}\nstatus: accepted\n---\nAbout ${id("BR", 1)}.\n`;
    const c = corpusOf(files);
    // the whole prompt is far above this budget only because of the list: the domain text alone is the README with its lists
    const msg = refusal(reviewPrompts(c.root, c.corpus, c.corpus.docs.filter((d) => d.id === id("BR", 1)), {}, 50 * KB));
    expect(msg).toContain("shorten the README of listed");
    expect(msg).not.toContain("canon rule domain");
  });

  test("BR-2359: a rule index and decision titles that alone exceed the budget: the refusal says splitting the change cannot help and gives no domain split", () => {
    const files: Record<string, string> = { "canon/rules/many/README.md": "---\ncode: [src/many]\n---\n# many\n\nMany.\n" };
    for (let n = 1; n <= 300; n++) files[`canon/rules/many/${id("BR", n)}.md`] = rule(n, `Rule number ${n} ${"t".repeat(80)}`, "Short.");
    const c = corpusOf(files);
    const msg = refusal(reviewPrompts(c.root, c.corpus, c.corpus.docs.filter((d) => d.id === id("BR", 1)), {}, 20 * KB));
    expect(msg).toContain("splitting the change cannot help");
    expect(msg).toContain("raise review_max_prompt_kb");
    expect(msg).not.toContain("canon rule domain");
    expect(msg).not.toContain("several smaller changes");
  });

  describe("a later call of a split review blocks only on its own domain text (D-83)", () => {
    function split() {
      const { root, corpus } = bigDomain(30);
      const r = reviewCalls(root, corpus, changedRule(corpus, 6), {}, 80 * KB);
      if (!r.ok) throw new Error(r.error.message);
      const { prompts: calls, scopes } = r.value;
      // a later call and a rule of big that only it shows
      const j = calls.findIndex((p, i) => i > 0 && [1, 2, 3, 4].some((n) => p.includes(`\n## ${id("BR", n)} ${TITLES[n]}\n`)));
      const n = [1, 2, 3, 4].find((k) => calls[j]!.includes(`\n## ${id("BR", k)} ${TITLES[k]}\n`))!;
      return { calls, scopes, j, n };
    }

    test("BR-2359: only the calls after the first say call 1 judges the changed documents themselves", () => {
      const { calls, scopes } = split();
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0]).not.toContain("Call 1 judges the changed documents themselves");
      expect(scopes[0]).toBeUndefined();
      for (const [i, p] of calls.entries()) if (i > 0) expect(p).toContain("Call 1 judges the changed documents themselves");
    });

    test("BR-2359: in a later call a finding naming a document of its domain text blocks; one naming only the changed rule is a note saying why; the old format is not rewritten", () => {
      const { calls, scopes, j, n } = split();
      const scope = scopes[j];
      const six = id("BR", 6);
      const against = parseAnswer({ findings: [{ criterion: "contradiction", text: `${six} contradicts ${id("BR", n)}` }] }, scope);
      expect(against).toEqual({ ok: true, value: { verdict: "block", findings: [`[contradiction] ${six} contradicts ${id("BR", n)}`] } });
      const alone = { findings: [{ criterion: "untestable", text: `${six} has no boundary` }] };
      expect(parseAnswer(alone, scope)).toEqual({ ok: true, value: { verdict: "ok", findings: [`(call ${j + 1} of ${calls.length}: names no document of its domain text, so it does not block; the changed documents themselves are judged in call 1) [untestable] ${six} has no boundary`] } });
      expect(parseAnswer(alone, scopes[0])).toEqual({ ok: true, value: { verdict: "block", findings: [`[untestable] ${six} has no boundary`] } });
      expect(parseAnswer({ verdict: "block", findings: [`${six} has no boundary`] }, scope)).toEqual({ ok: true, value: { verdict: "block", findings: [`${six} has no boundary`] } });
    });

    test("BR-2359: the same finding on the changed rule from every call blocks through call 1, and the later calls add it as a note", async () => {
      const { calls, scopes } = split();
      const six = id("BR", 6);
      const cmd = `cat > /dev/null; echo '{"findings":[{"criterion":"untestable","text":"${six} has no boundary"}]}'`;
      const r = await runReviews(cmd, tmpdir(), calls, { timeoutMs: 60_000, kind: "land" }, scopes);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.verdict).toBe("block");
      expect(r.value.findings[0]).toBe(`[untestable] ${six} has no boundary`);
      expect(r.value.findings.slice(1).every((f) => f.includes("so it does not block"))).toBe(true);
    }, 60_000);
  });
});

