import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";

const CLI = join(import.meta.dir, "../../../cli/main.ts");

describe("rule review at land", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return { root, promptFile };
  }

  test("BR-2009 BR-2036: a block verdict on changed rule text refuses the landing; the reviewer saw the whole domain and the index of every rule", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("is vague");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Domain: billing");
    expect(prompt).toContain(`- ${id} [billing] Refunds`);
    expect(prompt).toContain("language the documents are written in");
    expect(prompt).toContain("One rule is one trigger"); // the split criterion of D-5
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2253: the review.block event records the commit the reviewer saw", async () => {
    const { root } = reviewedProject("block");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const row = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'review.block'").get();
    const seen = (JSON.parse(row!.detail) as { commit?: string }).commit;
    expect(seen).toBe(sh(s.worktree, "rev-parse", "HEAD").trim());
  });

  test("BR-2009: a reviewer that fails to run refuses the landing", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("could not run");
  });

  /** A project with the billing domain on main and canon/config.yaml set to `config` (no review key when it has none). */
  function billingProject(config: string) {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), config);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return root;
  }
  const skips = (root: string) => ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.skip'").get()?.n;
  const id = ["BR", 1].join("-");
  const addRule = (wt: string) => {
    writeFileSync(join(wt, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(wt, "add", "-A");
    sh(wt, "commit", "-qm", "rule");
  };

  /** An executable reviewer script that saves its prompt and answers `verdict` (or runs `body` instead); returns its path and the prompt file. */
  function reviewer(root: string, body?: string, name = "review") {
    const script = join(root, "..", `${root.split("/").pop()}-${name}.sh`);
    const promptFile = `${script}.prompt`;
    writeFileSync(script, `#!/bin/sh\n${body ?? `cat > ${promptFile}\necho '{"verdict":"ok","findings":[]}'`}\n`);
    chmodSync(script, 0o755);
    return { script, promptFile };
  }
  /** Commits canon/config.yaml on main directly, as a landing that only changes it would. */
  const configOnMain = (root: string, config: string) => {
    writeFileSync(join(root, "canon/config.yaml"), config);
    sh(root, "commit", "-qam", "config");
  };
  /** Whether process `pid` is gone, waiting up to 3 s for it to be reaped. */
  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await Bun.sleep(100);
    }
    return false;
  }

  test("BR-2074 BR-2022: changed rule text with no review key is refused with exit 1, reason review, naming the rule, the reviewer command first and review: none as the owner's call", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(1);
    const said = `${out}${err}`;
    expect(said).toContain("land refused (review)");
    expect(said).toContain(id);
    expect(said).toContain("review: none");
    expect(said.indexOf('review: "claude -p --model sonnet --output-format text"')).toBeGreaterThan(-1);
    expect(said.indexOf('review: "claude -p --model sonnet --output-format text"')).toBeLessThan(said.indexOf("review: none"));
    expect(said).toContain("canon human ask");
    expect(skips(root)).toBe(0);
    expect(sh(root, "rev-parse", "main")).toBe(before);
  }, 30_000);

  test("BR-2074: a deleted decision with review set empty or blank is refused too; with no review key, code and change files alone land without a review", async () => {
    for (const blank of ['""', '"   "']) {
    const root = billingProject(`floor: "true"\ntests: []\nreview: ${blank}\n`);
    const d = ["D", 1].join("-");
    mkdirSync(join(root, "canon/decisions"), { recursive: true });
    writeFileSync(join(root, `canon/decisions/${d}.md`), `---\nid: ${d}\ntitle: Old\nstatus: proposed\n---\n\n## 背景\n\nx\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "decision");
    const s = startNew(root, "Drop decision");
    sh(s.worktree, "rm", "-q", `canon/decisions/${d}.md`);
    sh(s.worktree, "commit", "-qm", "drop");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain(`${d} (deleted)`);
    }
    const code = startNew(billingProject(`floor: "true"\ntests: []\n`), "Code only");
    writeFileSync(join(code.worktree, "src/billing/a.ts"), "export const a = 1;\n");
    sh(code.worktree, "add", "-A");
    sh(code.worktree, "commit", "-qm", "code");
    expect((await land(ws(code.worktree), FAST, quiet)).kind).toBe("landed");
  });

  test("BR-2074: with review: none changed rule text lands with a review: none line and a review.skip event", async () => {
    const root = billingProject(`floor: "true"\ntests: []\nreview: none\n`);
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const lines: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(lines.join("\n")).toContain(`review: none — ${id}`);
    expect(skips(root)).toBe(1);
  });

  test("BR-2074: the tree being landed decides: main turned the review on after the worktree started with none, and the rule is reviewed", async () => {
    const root = billingProject(`floor: "true"\ntests: []\nreview: none\n`);
    const s = startNew(root, "New rule");
    const r = reviewer(root);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    addRule(s.worktree);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(readFileSync(r.promptFile, "utf8")).toContain(id);
    expect(skips(root)).toBe(0);
  });

  test("BR-2074: main configured a reviewer after an old worktree started without the key: not refused as unconfigured, the rule is reviewed", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const s = startNew(root, "New rule");
    const r = reviewer(root);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    addRule(s.worktree);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(readFileSync(r.promptFile, "utf8")).toContain(id);
  });

  test("BR-2295: turning the review off or removing it in a landing that also changes a rule or a decision is refused, reviewer command first, then the owner's call", async () => {
    for (const next of ["review: none\n", ""]) {
      const root = billingProject(`floor: "true"\ntests: []\n`);
      const r = reviewer(root);
      configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
      const before = sh(root, "rev-parse", "main");
      const s = startNew(root, "Off and rule");
      writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\n${next}`);
      addRule(s.worktree);
      const out = await land(ws(s.worktree), FAST, quiet);
      expect(out.kind === "refused" && out.reason).toBe("review");
      const message = out.kind === "refused" ? out.message : "";
      expect(message).toContain(id);
      expect(message.indexOf("claude -p --model sonnet --output-format text")).toBeGreaterThan(-1);
      expect(message.indexOf("claude -p --model sonnet --output-format text")).toBeLessThan(message.indexOf("canon human ask"));
      expect(sh(root, "rev-parse", "main")).toBe(before);
      expect(existsSync(r.promptFile)).toBe(false);
    }
  });

  test("BR-2295: adding review: none while changing CLAUDE.md is refused; review: none alone lands; with none already on main a rule lands unreviewed", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "claude");
    const both = startNew(root, "Off and CLAUDE.md");
    writeFileSync(join(both.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\n`);
    writeFileSync(join(both.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(both.worktree, "commit", "-qam", "both");
    const refused = await land(ws(both.worktree), FAST, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("review");
    expect(refused.kind === "refused" && refused.message).toContain("CLAUDE.md");
    const alone = startNew(root, "Off alone");
    writeFileSync(join(alone.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: none\n`);
    sh(alone.worktree, "commit", "-qam", "off");
    expect((await land(ws(alone.worktree), FAST, quiet)).kind).toBe("landed");
    const later = startNew(root, "Rule after");
    addRule(later.worktree);
    expect((await land(ws(later.worktree), FAST, quiet)).kind).toBe("landed");
    expect(skips(root)).toBe(1);
  });

  test("BR-2074: a change that swaps the reviewer for one that always answers ok is still reviewed by main's command (#115)", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const strict = reviewer(root, `cat > /dev/null\necho '{"verdict":"block","findings":["${id} is vague"]}'`, "strict");
    const lenient = reviewer(root, undefined, "lenient");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const s = startNew(root, "Swap and rule");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(lenient.script)}\n`);
    addRule(s.worktree);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("rule review blocked");
    expect(existsSync(lenient.promptFile)).toBe(false); // the change's own reviewer never ran
  });

  test("BR-2074: with no reviewer on main, a change that sets one and changes a rule is refused; the reviewer landed alone first then reviews the rule", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const r = reviewer(root);
    const config = `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`;
    const both = startNew(root, "Reviewer and rule");
    writeFileSync(join(both.worktree, "canon/config.yaml"), config);
    addRule(both.worktree);
    const refused = await land(ws(both.worktree), FAST, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("review");
    expect(refused.kind === "refused" && refused.message).toContain("first, by itself");
    expect(existsSync(r.promptFile)).toBe(false);
    const alone = startNew(root, "Reviewer alone");
    writeFileSync(join(alone.worktree, "canon/config.yaml"), config);
    sh(alone.worktree, "commit", "-qam", "reviewer");
    expect((await land(ws(alone.worktree), FAST, quiet)).kind).toBe("landed");
    const later = startNew(root, "Rule after");
    addRule(later.worktree);
    expect((await land(ws(later.worktree), FAST, quiet)).kind).toBe("landed");
    expect(readFileSync(r.promptFile, "utf8")).toContain(id);
  });

  test("BR-2143: with no reviewer on main, a change that sets one and edits CLAUDE.md is refused and its own reviewer is never called (#115)", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "claude");
    const r = reviewer(root);
    const s = startNew(root, "Reviewer and CLAUDE.md");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("CLAUDE.md");
    expect(out.kind === "refused" && out.message).toContain("first, by itself");
    expect(existsSync(r.promptFile)).toBe(false);
  });

  test("BR-2143: a change that edits CLAUDE.md and drops it from instructions is still reviewed by main's list (#115)", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const strict = reviewer(root, `cat > /dev/null\necho '{"verdict":"block","findings":["stated twice"]}'`, "strict");
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/other.md"), "# Other\n"); // on main and untouched: listing it alone reviews nothing here
    sh(root, "add", "-A");
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\n`);
    const s = startNew(root, "Drop and edit");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(strict.script)}\ninstructions: [docs/other.md]\n`);
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "drop and edit");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("duplicate review blocked");
  });

  /** The review worktrees git still lists for `root`: the temporary ones sit under canon's state directory, in a `review` folder. */
  const reviewTrees = (root: string) => sh(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes("/review/"));

  test("BR-2216: the reviewer runs in one temporary worktree at main's commit for both reviews: main's script, CLAUDE.md, settings and skills, never the change's; it is gone afterwards", async () => {
    const root = billingProject(`floor: "true"
tests: []
`);
    const out = join(root, "..", `${root.split("/").pop()}-probe`);
    mkdirSync(out, { recursive: true });
    const body = (tag: string) => `#!/bin/sh\n{ echo "${tag}"; pwd -P; cat CLAUDE.md; cat .claude/settings.json; ls .claude/skills; } >> ${out}/seen.txt\ncat > /dev/null\necho '{"verdict":"${tag === "main-script" ? "ok" : "block"}","findings":["changed script ran"]}'\n`;
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/review.sh"), body("main-script"));
    chmodSync(join(root, "scripts/review.sh"), 0o755);
    writeFileSync(join(root, "CLAUDE.md"), "main claude\n");
    mkdirSync(join(root, ".claude/skills/old"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), '{"main":true}\n');
    writeFileSync(join(root, ".claude/skills/old/SKILL.md"), "---\nname: old\ndescription: Use when old.\n---\nold\n");
    sh(root, "add", "-A");
    configOnMain(root, `floor: "true"\ntests: []\nreview: scripts/review.sh\n`);
    // the primary checkout is on another branch and dirty: the review runs the same
    sh(root, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "dirty.txt"), "uncommitted\n");
    const s = startNew(root, "Rule and instructions");
    const mainSha = sh(root, "rev-parse", "main");
    writeFileSync(join(s.worktree, "scripts/review.sh"), body("changed-script"));
    writeFileSync(join(s.worktree, "CLAUDE.md"), "changed claude\n");
    writeFileSync(join(s.worktree, ".claude/settings.json"), '{"changed":true}\n');
    mkdirSync(join(s.worktree, ".claude/skills/new"), { recursive: true });
    writeFileSync(join(s.worktree, ".claude/skills/new/SKILL.md"), "---\nname: new\ndescription: Use when new.\n---\nnew\n");
    addRule(s.worktree);
    const out1 = await land(ws(s.worktree), FAST, quiet);
    expect(out1.kind).toBe("landed");
    const seen = readFileSync(join(out, "seen.txt"), "utf8");
    expect(seen.match(/main-script/g)?.length).toBe(2); // the rule review and the duplicate review, both main's script
    expect(seen).not.toContain("changed-script");
    expect(seen).not.toContain("changed claude");
    expect(seen).not.toContain('"changed"');
    expect(seen).toContain("main claude");
    expect(seen).toContain('{"main":true}');
    expect(seen).toMatch(/^old$/m);
    expect(seen).not.toMatch(/^new$/m);
    const cwds = [...seen.matchAll(/^main-script\n(.*)$/gm)].map((m) => m[1]!);
    expect(cwds[0]).toBe(cwds[1]); // one temporary worktree for both
    expect(cwds[0]).toContain("/review/");
    expect(cwds[0]).not.toBe(realpathSync(s.worktree));
    expect(existsSync(cwds[0]!)).toBe(false);
    expect(reviewTrees(root)).toEqual([]);
    expect(mainSha).not.toBe(sh(root, "rev-parse", "main")); // it landed
  });

  test("BR-2216: after ok, block, a failing command, an invalid verdict and a timeout the temporary worktree is gone, and no worktree is created when nothing needs a review", async () => {
    const cases: { name: string; body: string; config?: string; refused: boolean }[] = [
      { name: "ok", body: `echo '{"verdict":"ok","findings":[]}'`, refused: false },
      { name: "block", body: `echo '{"verdict":"block","findings":["no"]}'`, refused: true },
      { name: "exit", body: "exit 3", refused: true },
      { name: "invalid", body: "echo nothing", refused: true },
      { name: "timeout", body: "exec sleep 60", config: "review_timeout_minutes: 0.25\n", refused: true },
    ];
    for (const c of cases) {
      const root = billingProject(`floor: "true"\ntests: []\n`);
      const where = join(root, "..", `${root.split("/").pop()}-cwd.txt`);
      const r = reviewer(root, `pwd -P > ${where}\ncat > /dev/null\n${c.body}`, c.name);
      configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n${c.config ?? ""}`);
      const s = startNew(root, "New rule");
      addRule(s.worktree);
      const out = await land(ws(s.worktree), FAST, quiet);
      expect(out.kind === "refused" ? `${out.reason}: ${out.message}` : out.kind).toStartWith(c.refused ? "review" : "landed");
      expect([c.name, existsSync(where)]).toEqual([c.name, true]);
      const dir = readFileSync(where, "utf8").trim();
      expect(dir).toContain("/review/");
      expect(existsSync(dir)).toBe(false);
      expect(reviewTrees(root)).toEqual([]);
    }
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const r = reviewer(root);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const code = startNew(root, "Code only");
    writeFileSync(join(code.worktree, "src/billing/a.ts"), "export const a = 1;\n");
    sh(code.worktree, "add", "-A");
    sh(code.worktree, "commit", "-qm", "code");
    expect((await land(ws(code.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(r.promptFile)).toBe(false); // no review ran, so no worktree was made for one
  }, 60_000);

  test("BR-2216: a temporary worktree that cannot be removed is an environment refusal, not an ok verdict", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    // a locked worktree survives `git worktree remove --force`
    const r = reviewer(root, `cat > /dev/null\ngit worktree lock .\necho '{"verdict":"ok","findings":[]}'`);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    expect(out.kind === "refused" && out.message).toContain("could not be removed");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    for (const l of reviewTrees(root)) {
      const dir = l.slice("worktree ".length);
      sh(root, "worktree", "unlock", dir);
      sh(root, "worktree", "remove", "--force", dir);
    }
  });

  test("BR-2216 BR-2099: canon work land stopped by SIGTERM while the reviewer runs leaves no temporary worktree", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const pidFile = join(root, "..", `${root.split("/").pop()}-sig.pid`);
    const r = reviewer(root, `pwd -P > ${pidFile}.cwd\necho $$ > ${pidFile}\nexec sleep 30`);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(100);
    const dir = readFileSync(`${pidFile}.cwd`, "utf8").trim();
    expect(existsSync(dir)).toBe(true); // while the review runs it is there
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(existsSync(dir)).toBe(false);
    expect(reviewTrees(root)).toEqual([]);
  }, 40_000);

  test("BR-2296: a reviewer past review_timeout_minutes is stopped with its children and the landing is refused with reason review", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const pidFile = join(root, "..", `${root.split("/").pop()}-child.pid`);
    const r = reviewer(root, `sleep 90 &\necho $! > ${pidFile}\nwait`);
    // reason: 15 s leaves the reviewer time to start and write its pid under parallel floor load; 6 s did not (C-293)
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\nreview_timeout_minutes: 0.25\n`);
    const s = startNew(root, "New rule");
    // the change's own longer limit does not apply to its own landing: main's 6 s does (BR-2074, #115)
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\nreview_timeout_minutes: 60\n`);
    addRule(s.worktree);
    const started = Date.now();
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(Date.now() - started).toBeLessThan(60_000); // the limit is 15 s; the reviewer would sleep 90 s
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("did not finish within");
    expect(await gone(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  }, 75_000);

  test("BR-2296 BR-2099: canon work land stopped by SIGTERM while the reviewer runs exits 143 and stops the reviewer", async () => {
    const root = billingProject(`floor: "true"\ntests: []\n`);
    const pidFile = join(root, "..", `${root.split("/").pop()}-reviewer.pid`);
    const r = reviewer(root, `echo $$ > ${pidFile}\nexec sleep 30`);
    configOnMain(root, `floor: "true"\ntests: []\nreview: ${JSON.stringify(r.script)}\n`);
    const s = startNew(root, "New rule");
    addRule(s.worktree);
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(100);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(await gone(pid)).toBe(true);
  }, 40_000);

  test("BR-2009: changing only a domain README is reviewed, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Readme only");
    writeFileSync(join(s.worktree, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nRules here are optional.\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(s.worktree, "commit", "-qam", "readme");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(readFileSync(promptFile, "utf8")).toContain("Rules here are optional.");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2009: deleting a rule file is reviewed with the text it had on main, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`);
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"block","findings":["deleting it drops a promise"]}'''\n`);
    sh(root, "commit", "-qam", "blocking reviewer");
    const s = startNew(root, "Delete rule");
    sh(s.worktree, "rm", "-q", `canon/rules/billing/${id}.md`);
    sh(s.worktree, "commit", "-qm", "delete");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/${id}.md`);
    expect(prompt).toContain("Refunds within 30 days.");
  });

  test("BR-2009: a rule file moved with identical content is not reviewed; moved and edited is reviewed as deleted plus added", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const text = `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`;
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), text);
    mkdirSync(join(seed.worktree, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(seed.worktree, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    rmSync(promptFile, { force: true });

    const move = startNew(root, "Move rule");
    sh(move.worktree, "mv", `canon/rules/billing/${id}.md`, `canon/rules/billing/refunds/${id}.md`);
    sh(move.worktree, "commit", "-qm", "move");
    const lines: string[] = [];
    expect((await land(ws(move.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    expect(lines).toContain("review: 1 file(s) only moved, not reviewed");

    const edit = startNew(root, "Move and edit");
    sh(edit.worktree, "mv", `canon/rules/billing/refunds/${id}.md`, `canon/rules/billing/${id}.md`);
    writeFileSync(join(edit.worktree, `canon/rules/billing/${id}.md`), text.replace("30", "31"));
    sh(edit.worktree, "commit", "-qam", "move and edit");
    expect((await land(ws(edit.worktree), FAST, quiet)).kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Refunds within 31 days.");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/refunds/${id}.md`);
  });

  test("BR-2010: the reviewer is not asked when no rule or decision text changed", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Code only");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "code");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("duplicate review of standing instructions at land", () => {
  const GUIDE = "- Ask the human only about direction.";
  function standingProject(verdict: "ok" | "block", extra = "") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-standing.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${extra}review: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["CLAUDE.md repeats the guide"]}'''\n`);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, ".claude/skills/x"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing tests\n---\nbody\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "standing");
    return { root, promptFile };
  }

  test("BR-2143: a block verdict on an edited CLAUDE.md refuses the landing; the reviewer saw the new text, the guide and the skill descriptions", async () => {
    const { root, promptFile } = standingProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\n- Only ask the human about direction.\n");
    sh(s.worktree, "commit", "-qam", "instructions");
    const out = await land(ws(s.worktree), { ...FAST, guide: GUIDE }, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("CLAUDE.md repeats the guide");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Changed in this landing: CLAUDE.md");
    expect(prompt).toContain("Only ask the human about direction.");
    expect(prompt).toContain(GUIDE);
    expect(prompt).toContain(".claude/skills/x/SKILL.md: Use when writing tests");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2143: an edited skill is reviewed and an ok verdict lands", async () => {
    const { root, promptFile } = standingProject("ok");
    const s = startNew(root, "Edit skill");
    writeFileSync(join(s.worktree, ".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: Use when writing or reviewing tests\n---\nbody\n");
    sh(s.worktree, "commit", "-qam", "skill");
    expect((await land(ws(s.worktree), { ...FAST, guide: GUIDE }, quiet)).kind).toBe("landed");
    expect(readFileSync(promptFile, "utf8")).toContain("# Changed in this landing: .claude/skills/x/SKILL.md");
  });

  test("BR-2143 BR-2231: with instructions configured, only the listed files trigger the review; code alone and deletions never do; a listed file cannot be deleted while listed", async () => {
    const { root, promptFile } = standingProject("block", "instructions: [docs/agent.md]\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/agent.md"), "# Agent\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "agent doc");
    const a = startNew(root, "Edit CLAUDE.md only");
    writeFileSync(join(a.worktree, "CLAUDE.md"), "# Project\n\nmore\n");
    writeFileSync(join(a.worktree, "app.txt"), "code\n");
    sh(a.worktree, "add", "-A");
    sh(a.worktree, "commit", "-qm", "not listed");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    const gone = startNew(root, "Delete the listed file");
    sh(gone.worktree, "rm", "-q", "docs/agent.md");
    sh(gone.worktree, "commit", "-qm", "delete");
    const refused = await land(ws(gone.worktree), FAST, quiet);
    expect(refused.kind === "refused" && refused.reason).toBe("check"); // still listed in instructions (BR-2231)
    // reason: a listed instruction file cannot be deleted while still listed (BR-2231), so the deletion is a skill's
    const d = startNew(root, "Delete a skill");
    sh(d.worktree, "rm", "-q", ".claude/skills/x/SKILL.md");
    sh(d.worktree, "commit", "-qm", "delete");
    expect((await land(ws(d.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    const b = startNew(root, "Edit the listed file");
    writeFileSync(join(b.worktree, "docs/agent.md"), "# Agent\n\nnew\n");
    sh(b.worktree, "add", "-A");
    sh(b.worktree, "commit", "-qm", "listed");
    const out = await land(ws(b.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(readFileSync(promptFile, "utf8")).toContain("# docs/agent.md (instruction file, loaded whole)");
  });

  test("BR-2143: an edited CLAUDE.md with no review key is refused with reason review; with review: none it lands with a review.skip event", async () => {
    for (const review of ["", "review: none\n"]) {
      const root = project();
      writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\n${review}`);
      writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
      sh(root, "add", "-A");
      sh(root, "commit", "-qm", "claude");
      const s = startNew(root, "Edit CLAUDE.md");
      writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
      sh(s.worktree, "commit", "-qam", "edit");
      const lines: string[] = [];
      const out = await land(ws(s.worktree), FAST, (l) => lines.push(l));
      const skipped = ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.skip'").get()?.n;
      if (review === "") {
        expect(out.kind === "refused" && out.reason).toBe("review");
        expect(out.kind === "refused" && out.message).toContain("CLAUDE.md");
        expect(out.kind === "refused" && out.message).toContain("review: none");
        expect(out.kind === "refused" && out.message).toContain("canon human ask");
        expect(skipped).toBe(0);
      } else {
        expect(out.kind).toBe("landed");
        expect(lines.join("\n")).toContain("review: none — CLAUDE.md");
        expect(skipped).toBe(1);
      }
    }
  });

  test("BR-2143: a duplicate reviewer that fails to run refuses the landing", async () => {
    const { root } = standingProject("ok");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    sh(root, "commit", "-qam", "failing reviewer");
    const s = startNew(root, "Edit CLAUDE.md");
    writeFileSync(join(s.worktree, "CLAUDE.md"), "# Project\n\nnew\n");
    sh(s.worktree, "commit", "-qam", "edit");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("duplicate review could not run");
  });
});
