import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCorpus } from "../documents/read.ts";
import { duplicatePrompt, reviewPrompt, runReview, standingText } from "./review.ts";

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

describe("rule review prompt", () => {
  test("BR-2036: the prompt lists every active rule with its domain and every accepted decision, not proposed ones", () => {
    const { root, corpus } = corpusOf(files);
    const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === id("BR", 4)));
    expect(prompt).toContain(`- ${id("BR", 3)} [work/land] Land in order`);
    expect(prompt).toContain(`# Accepted decisions\n\n- ${id("D", 1)} Why a queue`);
    expect(prompt).not.toContain("Maybe later");
  });
});

describe("review command", () => {
  const answer = (out: string) => runReview(`printf '%s' '${out}'`, tmpdir(), "prompt");

  test("BR-2216: the prompt goes in on stdin; the verdict JSON may be surrounded by other text; missing findings are none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-review-cmd-"));
    const seen = join(dir, "stdin.txt");
    const r = await runReview(`cat > ${seen}; echo 'Here is my answer: {"verdict":"block","findings":["BR-1 is vague"]} done'`, dir, "the prompt text");
    expect(r).toEqual({ ok: true, value: { verdict: "block", findings: ["BR-1 is vague"] } });
    expect(await Bun.file(seen).text()).toBe("the prompt text");
    expect(await answer('{"verdict":"ok"}')).toEqual({ ok: true, value: { verdict: "ok", findings: [] } });
    await runReview(`pwd > ${join(dir, "cwd.txt")}; echo '{"verdict":"ok"}'`, dir, "p");
    expect(realpathSync((await Bun.file(join(dir, "cwd.txt")).text()).trim())).toBe(realpathSync(dir)); // run in the given directory
  });

  test("BR-2216: no JSON, JSON that does not parse, a verdict other than ok or block, or a non-zero exit is an error", async () => {
    for (const out of ["looks fine to me", '{"verdict":"ok",}', '{"verdict":"maybe","findings":[]}']) {
      const r = await answer(out);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("invalid");
    }
    const failed = await runReview("echo boom >&2; exit 3", tmpdir(), "p");
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.message).toBe("review command exited 3: boom");
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
