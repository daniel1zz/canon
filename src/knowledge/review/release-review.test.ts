import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { quoteIsOld, releasePrompts, reportBlock, RELEASE_ISSUE_TITLE, type ShippedText } from "./release-review.ts";
import { Database } from "bun:sqlite";

const SCRIPT = join(import.meta.dir, "../../../scripts/release.ts");

/**
 * A canon-like repository with two shipped skills and a project skill, a reviewer that saves each prompt and its
 * CANON_REVIEW_KIND and answers from `answer.json`, and a `gh` stand-in that logs its calls and lists `open.json`.
 */
function releaseRepo(answer: unknown, open: unknown[] = []) {
  const root = project();
  const tools = mkdtempSync(join(tmpdir(), "canon-release-tools-"));
  writeFileSync(join(tools, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(tools, "open.json"), JSON.stringify(open));
  writeFileSync(join(tools, "review.sh"), `#!/bin/sh\nn=$(ls ${tools} | grep -c '^prompt-')\ncat > ${tools}/prompt-$n.txt\necho "$CANON_REVIEW_KIND" >> ${tools}/kind.txt\ncat ${tools}/answer.json\n`);
  writeFileSync(join(tools, "gh.sh"), `#!/bin/sh\necho "$@" >> ${tools}/gh.log\nif [ "$2" = list ]; then cat ${tools}/open.json; fi\nif [ "$2" = create ]; then echo https://github.com/o/r/issues/9; fi\n`);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: sh ${join(tools, "review.sh")}\n`);
  for (const [name, text] of [["canon-a", "Always run the tests before landing."], ["canon-b", "Run the tests before you land."], ["mine", "Project skill."]] as const) {
    mkdirSync(join(root, `.claude/skills/${name}`), { recursive: true });
    writeFileSync(join(root, `.claude/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Use for ${name}\n---\n${text}\n`);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "skills");
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CANON_GREEN: sh(root, "rev-parse", "HEAD"), CANON_PRIMARY: root, CANON_GH: `sh ${join(tools, "gh.sh")}`, CANON_RELEASE_BUILD: "fake", CANON_ACTOR: "agent:test" },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const prompts = () => (existsSync(tools) ? Bun.spawnSync(["sh", "-c", `ls ${tools} | grep -c '^prompt-' || true`]).stdout.toString().trim() : "0");
  const ghLog = () => (existsSync(join(tools, "gh.log")) ? readFileSync(join(tools, "gh.log"), "utf8") : "");
  return { root, tools, run, prompts, ghLog };
}

describe("release check (BR-2411)", () => {
  test("BR-2411 BR-2412 BR-2366: an ok check reviews every canon skill and the guide in full in one call, then publishes dist/canon and dist/skills; the same texts are not reviewed again", () => {
    const { root, tools, run, prompts } = releaseRepo({ findings: [] });
    const r = run();
    expect([r.code, r.err]).toEqual([0, ""]);
    const prompt = readFileSync(join(tools, "prompt-0.txt"), "utf8");
    expect(prompt).toContain("# .claude/skills/canon-a/SKILL.md (shipped by canon, full text)\n\n---\nname: canon-a");
    expect(prompt).toContain("Always run the tests before landing.");
    expect(prompt).toContain("Run the tests before you land.");
    expect(prompt).not.toContain("Project skill.");
    expect(prompt).toContain("# guide: canon brief workflow guide");
    expect(readFileSync(join(tools, "kind.txt"), "utf8")).toBe("release\n");
    const green = sh(root, "rev-parse", "HEAD");
    expect(readFileSync(join(root, "dist/canon"), "utf8")).toBe(`fake canon ${green}\n`);
    expect(readlinkSync(join(root, "dist/skills"))).toBe(`skills-${green}`);
    expect(readFileSync(join(root, "dist/skills/canon-b/SKILL.md"), "utf8")).toContain("Run the tests before you land.");
    expect(existsSync(join(root, "dist/skills/mine"))).toBe(false);
    const again = run();
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing changed");
    expect(prompts()).toBe("1");
  });

  test("BR-2411 BR-2367 D-107: after a release only a duplicate touching a line changed since then blocks; one quoted wholly from released text is a note; no places or a quote not found still blocks", () => {
    const { root, tools, run, prompts } = releaseRepo({ findings: [] });
    expect(run().code).toBe(0);
    const first = sh(root, "rev-parse", "HEAD");
    const db = new Database(join(root, ".git/canon/state.db"));
    const published = db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'release.published'").all().map((r) => JSON.parse(r.detail) as { commit: string; guide: string });
    db.close();
    expect(published.map((p) => p.commit)).toEqual([first]);
    expect(published[0]!.guide.length).toBeGreaterThan(0);
    writeFileSync(join(root, ".claude/skills/canon-b/SKILL.md"), "---\nname: canon-b\ndescription: Use for canon-b\n---\nRun the tests before you land.\nKeep each commit small.\n");
    sh(root, "commit", "-qam", "canon-b grows");
    // reason: the same texts reuse the recorded verdict, so each answer below is asked for afresh
    const forget = () => {
      const d = new Database(join(root, ".git/canon/state.db"));
      d.run("DELETE FROM events WHERE kind = 'release.review'");
      d.close();
    };
    const answer = (places: unknown) => forget() ?? writeFileSync(join(tools, "answer.json"), JSON.stringify({ findings: [{ criterion: "duplication", text: "canon-a and canon-b both require tests before landing", ...(places === undefined ? {} : { places }) }] }));
    answer([{ file: ".claude/skills/canon-a/SKILL.md", quote: "Always run the tests before landing." }, { file: ".claude/skills/canon-b/SKILL.md", quote: "Run the tests  before you land." }]);
    const old = run("--check");
    expect([old.code, old.err]).toEqual([0, ""]);
    expect(old.out).toContain("note: (already released) canon-a and canon-b both require tests before landing");
    const prompt = readFileSync(join(tools, `prompt-${Number(prompts()) - 1}.txt`), "utf8");
    expect(prompt).toContain(`Lines added or changed since the last release in .claude/skills/canon-b/SKILL.md (line number, then the line):\n6: Keep each commit small.`);
    expect(prompt).toContain("Lines added or changed since the last release in .claude/skills/canon-a/SKILL.md: none.");
    answer([{ file: ".claude/skills/canon-a/SKILL.md", quote: "Always run the tests before landing." }, { file: ".claude/skills/canon-b/SKILL.md", quote: "Keep each commit small." }]);
    expect(run("--check").code).toBe(1);
    answer(undefined);
    expect(run("--check").code).toBe(1);
    answer([{ file: ".claude/skills/canon-a/SKILL.md", quote: "Always run the tests before landing." }, { file: ".claude/skills/canon-b/SKILL.md", quote: "words that are nowhere" }]);
    expect(run("--check").code).toBe(1);
  });

  test("BR-2411 D-107: with nothing released yet every line counts as changed, so any duplication blocks", () => {
    const { tools, run } = releaseRepo({ findings: [{ criterion: "duplication", text: "a repeats b", places: [{ file: ".claude/skills/canon-a/SKILL.md", quote: "Always run the tests before landing." }] }] });
    const r = run("--check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("baseline: none");
    expect(readFileSync(join(tools, "prompt-0.txt"), "utf8")).toContain("all of them (there is no earlier release)");
  });

  test("BR-2411 D-107: a quote is matched with whitespace as one space and is old only when every place it is found avoids the changed lines", () => {
    const text = "one two\nthree four\nfive\none two\n";
    expect(quoteIsOld(text, "two three", new Set([3]))).toBe(true);
    expect(quoteIsOld(text, "two three", new Set([2]))).toBe(false);
    expect(quoteIsOld(text, "one two", new Set([4]))).toBe(false);
    expect(quoteIsOld(text, "absent", new Set())).toBe(false);
  });

  test("BR-2411: a block publishes nothing, prints the findings, files one issue and exits 1; the next run with the same texts reuses the block without a review or a second issue", () => {
    const { root, run, prompts, ghLog } = releaseRepo({ findings: [{ criterion: "duplication", text: "canon-a and canon-b both require running the tests before landing" }] });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist/canon"), "previous release\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("blocked, nothing published");
    expect(r.err).toContain("canon-a and canon-b both require running the tests before landing");
    expect(r.err).toContain("https://github.com/o/r/issues/9");
    expect(readFileSync(join(root, "dist/canon"), "utf8")).toBe("previous release\n");
    expect(existsSync(join(root, "dist/skills"))).toBe(false);
    expect(ghLog()).toContain(`issue create --title ${RELEASE_ISSUE_TITLE} --label canon-review`);
    const again = run();
    expect(again.code).toBe(1);
    expect(again.err).toContain("canon-a and canon-b both require");
    expect(prompts()).toBe("1");
    expect(ghLog().match(/issue create/g)?.length).toBe(1);
    // --check reviews the current checkout and files nothing
    expect(run("--check").code).toBe(1);
    expect(ghLog().match(/issue create/g)?.length).toBe(1);
  });

  test("BR-2411: with no review command configured the check exits 4 and publishes nothing", () => {
    const { root, run } = releaseRepo({ findings: [] });
    writeFileSync(join(root, "canon/config.yaml"), 'floor: "true"\ntests: []\nreview: none\n');
    sh(root, "commit", "-qam", "no reviewer");
    const r = run();
    expect(r.code).toBe(4);
    expect(r.err).toContain("nothing is published");
    expect(existsSync(join(root, "dist/canon"))).toBe(false);
  });

  test("BR-2411: a review command that fails exits 4 and publishes nothing", () => {
    const { root, tools, run } = releaseRepo({ findings: [] });
    writeFileSync(join(tools, "review.sh"), "#!/bin/sh\ncat > /dev/null\nexit 3\n");
    const r = run();
    expect(r.code).toBe(4);
    expect(r.err).toContain("could not run");
    expect(existsSync(join(root, "dist/canon"))).toBe(false);
  });

  test("BR-2411: a block with an open issue of the same title becomes a comment on it", () => {
    const { root, tools, ghLog } = releaseRepo({ findings: [] }, [{ number: 31, title: RELEASE_ISSUE_TITLE }]);
    const named = reportBlock(root, `sh ${join(tools, "gh.sh")}`, "abc1234567", ["x repeats y"]);
    expect(named.ok && named.value).toBe("#31");
    expect(ghLog()).toContain("issue comment 31 --body");
    expect(ghLog()).not.toContain("issue create");
  });

  test("BR-2411: over review_max_prompt_kb the skills are split so every two of them meet in one call, each call within the budget; too small a budget is refused with the sizes", () => {
    const texts: ShippedText[] = Array.from({ length: 6 }, (_, i) => ({ path: `.claude/skills/canon-${i}/SKILL.md`, text: `skill ${i} ${"x".repeat(3000)}` }));
    const guide = "- Ask the human only about direction.";
    const one = releasePrompts(texts, guide, 250 * 1024);
    expect(one.ok && one.value.length).toBe(1);
    const budget = 12 * 1024;
    const split = releasePrompts(texts, guide, budget);
    if (!split.ok) throw new Error(split.error.message);
    expect(split.value.length).toBeGreaterThan(1);
    for (const p of split.value) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(budget);
      expect(p).toContain(guide);
      expect(p).toMatch(/This is call \d+ of \d+/);
    }
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        expect([i, j, split.value.some((p) => p.includes(`skill ${i} `) && p.includes(`skill ${j} `))]).toEqual([i, j, true]);
      }
    }
    // one skill over half of what is left after the fixed part fits in no chunk: refused, even though it and a small one fit together
    const lopsided: ShippedText[] = [{ path: ".claude/skills/canon-big/SKILL.md", text: "big " + "y".repeat(7000) }, ...texts.slice(0, 2)];
    const big = releasePrompts(lopsided, guide, budget);
    expect(!big.ok && big.error.message).toContain("twice the largest skill");
    const refused = releasePrompts(texts, guide, 5 * 1024);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain("raise review_max_prompt_kb to at least");
  });
});
