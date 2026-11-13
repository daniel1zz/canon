import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { previewReview } from "./preview.ts";
import { standingText } from "./review.ts";
import { project, sh, startNew, ws } from "../../work/testkit.ts";

for (const path of ["AGENTS.md", "AGENTS.override.md", ".agents/skills/custom/SKILL.md"]) {
  test(`BR-2143: preview reviews Codex ${path} even with an older explicit instructions list`, async () => {
    const root = project();
    const prompt = `${root}-codex-review-prompt`;
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = `cat > ${quote(prompt)}; echo '{"verdict":"ok","findings":[]}'`;
    writeFileSync(join(root, "custom.md"), "Team instructions\n");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\ninstructions: [custom.md]\nreview: ${JSON.stringify(command)}\n`);
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "review configuration");
    const change = startNew(root, "Codex instructions");
    mkdirSync(dirname(join(change.worktree, path)), { recursive: true });
    writeFileSync(join(change.worktree, path), path.endsWith("SKILL.md") ? "---\nname: custom\ndescription: Codex custom procedure\n---\nDetailed Codex instruction\n" : "# Codex\n\nDetailed Codex instruction\n");
    sh(change.worktree, "add", "-A");
    sh(change.worktree, "commit", "-qm", "Codex instructions");
    expect((await previewReview(ws(change.worktree), "workflow")).kind).toBe("ok");
    expect(existsSync(prompt)).toBe(true);
    const text = readFileSync(prompt, "utf8");
    expect(text).toContain(path);
    expect(text).toContain("Detailed Codex instruction");
    expect(text).toContain("Team instructions");
  });
}

test("BR-2143: two host entries for the same physical skill contribute one description", () => {
  const root = project();
  mkdirSync(join(root, ".claude/skills/custom"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/custom/SKILL.md"), "---\nname: custom\ndescription: One physical procedure\n---\nBody\n");
  mkdirSync(join(root, ".agents"));
  symlinkSync("../.claude/skills", join(root, ".agents/skills"));
  expect(standingText(root, []).skills.map((s) => s.description)).toEqual(["One physical procedure"]);
});
