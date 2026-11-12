import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { partsNote, reviewPrompt, reviewPromptParts, reviewPrompts, runReviews } from "./review.ts";

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

  describe("the calls run at once, at most review_parallel of them (D-83)", () => {
    const limits = { timeoutMs: 60_000, kind: "land" as const };
    const ok = `cat > /dev/null; sleep 1; echo '{"findings":[]}'`;

    test("BR-2359: four calls of one second each take about one second with review_parallel 4 and about four with 1", async () => {
      const four = ["a", "b", "c", "d"];
      let t = Date.now();
      expect((await runReviews(ok, tmpdir(), four, limits, 4)).ok).toBe(true);
      expect(Date.now() - t).toBeLessThan(3000);
      t = Date.now();
      expect((await runReviews(ok, tmpdir(), four, limits, 1)).ok).toBe(true);
      expect(Date.now() - t).toBeGreaterThanOrEqual(4000);
    }, 60_000);

    test("BR-2359 BR-2216: a call that fails stops the calls still running with their children, and the review fails with the first failure", async () => {
      const dir = mkdtempSync(join(tmpdir(), "canon-parallel-"));
      const pid = join(dir, "pid");
      const cmd = `p=$(cat); case "$p" in *FAIL*) sleep 1; echo broken >&2; exit 1;; *) sleep 30 & echo $! > ${pid}; wait;; esac`;
      const t = Date.now();
      const r = await runReviews(cmd, dir, ["FAIL", "slow"], limits, 2);
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("broken");
      const child = Number(readFileSync(pid, "utf8").trim());
      // reason: the kill is sent before runReviews returns, but a loaded machine may take a moment to end the process or
      // reap it; a zombie still answers kill(pid, 0). Wait a bounded time for it to be gone or a zombie (#187).
      const gone = () => {
        try {
          process.kill(child, 0);
        } catch {
          return true;
        }
        return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)]).stdout.toString().trim().startsWith("Z");
      };
      const until = Date.now() + 5000;
      while (!gone() && Date.now() < until) await Bun.sleep(50);
      expect(gone()).toBe(true);
    }, 60_000);

    test("BR-2359: the findings are merged in call order whichever call ends first", async () => {
      const cmd = `p=$(cat); case "$p" in *first*) sleep 1; echo '{"findings":[{"criterion":"note","text":"one"}]}';; *) echo '{"findings":[{"criterion":"note","text":"two"}]}';; esac`;
      const r = await runReviews(cmd, tmpdir(), ["first", "second"], limits, 2);
      expect(r).toEqual({ ok: true, value: { verdict: "ok", findings: ["one", "two"] } });
    }, 60_000);
  });
});

describe("a review after landing split by its changed documents (BR-2448)", () => {
  const decision = (n: number, kb: number) => `---\nid: ${id("D", n)}\ntitle: Choice ${n}\nstatus: accepted\n---\n## 背景\n\nFIRST-${n} opens choice ${n}.\n\n${fat(`BODY-${n}`, kb)}\n`;
  /** Three changed decisions of `kb` KB each that name no rule, so the prompt is the head and the tail only; a small domain `small`. */
  function decisions(kb: number) {
    const { root, corpus } = corpusOf({
      "canon/rules/small/README.md": "---\ncode: [src/small]\n---\n# small\n\nSmall.\n",
      [`canon/rules/small/${id("BR", 5)}.md`]: rule(5, "Small five", "Short text."),
      [`canon/decisions/${id("D", 2)}.md`]: decision(2, kb),
      [`canon/decisions/${id("D", 3)}.md`]: decision(3, kb),
      [`canon/decisions/${id("D", 4)}.md`]: decision(4, kb),
    });
    return { root, corpus, changed: corpus.docs.filter((d) => d.kind === "decision") };
  }
  const parted = (r: ReturnType<typeof reviewPromptParts>) => {
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const full = (p: string, n: number) => p.includes(`\n## ${id("D", n)} Choice ${n} (decision, accepted)\n`);

  test("BR-2448 BR-2359: changed documents that do not fit one call are reviewed in parts; each is in full in exactly one part, every other part lists it by id, title and first line, and no call is over the budget", () => {
    const { root, corpus, changed } = decisions(30);
    const budget = 80 * KB;
    expect(reviewPrompts(root, corpus, changed, {}, budget).ok).toBe(false); // BR-2359 alone cannot
    const r = parted(reviewPromptParts(root, corpus, changed, {}, budget));
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.prompts).toHaveLength(r.parts.length);
    for (const p of r.prompts) expect(size(p)).toBeLessThanOrEqual(budget);
    for (const n of [2, 3, 4]) {
      expect(r.prompts.filter((p) => full(p, n))).toHaveLength(1);
      for (const p of r.prompts.filter((q) => !full(q, n))) expect(p).toContain(`\n- ${id("D", n)} Choice ${n} (decision, accepted): FIRST-${n} opens choice ${n}.\n`);
    }
    for (const [i, p] of r.prompts.entries()) {
      expect(p).toContain(`this is part ${i + 1} of ${r.parts.length}`);
      expect(p).toContain("# Other changed documents in this landing");
      expect(p).toContain("never block because a changed document is not shown in full in this part");
    }
    expect(partsNote(r.parts)).toBe(`the changed documents do not fit one call, so they are reviewed in ${r.parts.length} parts: ${r.parts.map((g, i) => `${i + 1}: ${g.map((d) => d.id).join(", ")}`).join("; ")}`);
  });

  test("BR-2448: changed documents that fit one call give BR-2359's prompt, with no part", () => {
    const { root, corpus, changed } = decisions(30);
    const r = parted(reviewPromptParts(root, corpus, changed, {}, 250 * KB));
    expect(r.prompts).toEqual([reviewPrompt(root, corpus, changed)]);
    expect(r.prompts[0]).not.toContain("Other changed documents");
    expect(partsNote(r.parts)).toBeUndefined();
  });

  test("BR-2448: a changed document too large even alone fails with the sizes of that document in a part of its own; the deleted documents travel only with the first part", () => {
    const { root, corpus, changed } = decisions(30);
    const big = decision(2, 120);
    const huge = { ...corpus, docs: corpus.docs.map((d) => (d.id === id("D", 2) ? { ...d, body: big } : d)) };
    const hugeChanged = huge.docs.filter((d) => d.kind === "decision");
    const r = reviewPromptParts(root, huge, hugeChanged, {}, 80 * KB);
    expect(r.ok).toBe(false);
    // the sizes are those of that one document in a part of its own: 120 KB of changed documents, not the 180 KB of all three
    if (!r.ok) expect(r.error.message).toMatch(/cannot be made smaller than 12\d KB .*review_max_prompt_kb = 80 KB; sizes: changed documents 12\d KB/);
    const deleted = [{ id: id("BR", 7), path: "canon/rules/small/BR-7.md", text: "GONE-7 was here." }];
    const split = parted(reviewPromptParts(root, corpus, changed, { deleted }, 80 * KB));
    expect(split.prompts[0]).toContain("GONE-7 was here.");
    for (const p of split.prompts.slice(1)) expect(p).not.toContain("GONE-7");
  });
});

