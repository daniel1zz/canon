import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";
import { reviewScope } from "../../work/land/checks/review-scope.ts";
import { readCorpus } from "./read.ts";
import { reviewPrompt, reviewPromptParts } from "../review/review.ts";

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
const rule = (id: string, status: string, extra = "") => `---\nid: ${id}\ntitle: Rule ${id}\nstatus: ${status}\nuntested: demo\n${extra}---\n\n## 规则\n\nRefusal reasons are a and b.\n\n## 例子\n\n- x → y\n`;

function repo(files: Record<string, string>) {
  const root = project();
  mkdirSync(join(root, "canon/rules/game"), { recursive: true });
  writeFileSync(join(root, "canon/rules/game/README.md"), "---\ncode: [src/game]\n---\n# game\n\n## 术语\n\n- **原因**：拒绝的理由\n\n## 业务\n\n- **x**：y\n");
  mkdirSync(join(root, "src/game"), { recursive: true });
  writeFileSync(join(root, "src/game/.keep"), "");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "canon/rules/game", name), text);
  return root;
}
const check = (root: string) => {
  const r = Bun.spawnSync(["bun", MAIN, "check", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return (JSON.parse(r.stdout.toString() || "[]") as { rule: string; path: string; message: string }[]).filter((f) => f.rule === "will-amend-target" || f.rule === "file-invalid");
};
const corpus = (root: string) => readCorpus(root, ws(root).config.types, ws(root).config).corpus;

describe("a planned rule's will_amend (BR-2496)", () => {
  test("BR-2496: will_amend naming another active rule is fine and is marked in canon context; itself, a missing id, a non-rule or a rule not active is will-amend-target", () => {
    const ok = repo({ "BR-300.md": rule("BR-300", "active"), "BR-1022.md": rule("BR-1022", "planned", "will_amend: [BR-300]\n") });
    expect(check(ok)).toEqual([]);
    const ctx = Bun.spawnSync(["bun", MAIN, "context", "game", "--full"], { cwd: ok, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } }).stdout.toString();
    expect(ctx).toContain("## BR-1022 [规划中] [生效时改 BR-300] Rule BR-1022");
    const bad = repo({
      "BR-300.md": rule("BR-300", "retired"),
      "BR-1.md": rule("BR-1", "planned", "will_amend: [BR-1]\n"),
      "BR-2.md": rule("BR-2", "planned", "will_amend: [BR-99]\n"),
      "BR-3.md": rule("BR-3", "planned", "will_amend: [BR-300]\n"),
    });
    const msgs = check(bad).filter((f) => f.rule === "will-amend-target").map((f) => `${f.path} ${f.message}`);
    expect(msgs.find((m) => m.includes("BR-1.md"))).toContain("will_amend names itself");
    expect(msgs.find((m) => m.includes("BR-2.md"))).toContain("BR-99, which does not exist");
    expect(msgs.find((m) => m.includes("BR-3.md"))).toContain("BR-300, which is retired, not active");
  });

  test("BR-2496: will_amend that is not a non-empty list, or on a rule that is not planned, is file-invalid", () => {
    for (const [extra, status, want] of [["will_amend: []\n", "planned", "non-empty list"], ["will_amend: BR-300\n", "planned", "non-empty list"], ["will_amend: [BR-300]\n", "active", "only for a planned rule"]] as const) {
      const root = repo({ "BR-300.md": rule("BR-300", "active"), "BR-5.md": rule("BR-5", status, extra) });
      const f = check(root).filter((x) => x.rule === "file-invalid");
      expect(f.map((x) => x.message).join("\n")).toContain(want);
    }
  });
});

describe("the review and a declared future change (BR-2036)", () => {
  test("BR-2036 BR-2496: the prompt tells the reviewer a declared future change is no contradiction, and shows will_amend in the index and the changed document", () => {
    const root = repo({ "BR-300.md": rule("BR-300", "active"), "BR-1022.md": rule("BR-1022", "planned", "will_amend: [BR-300]\n") });
    const c = corpus(root);
    const planned = c.docs.find((d) => d.id === "BR-1022")!;
    const prompt = reviewPrompt(root, c, [planned]);
    expect(prompt).toContain("a difference its own text says it will make in that rule when it becomes active is a declared future change");
    expect(prompt).toContain("Report any other conflict between them as usual");
    expect(prompt).toContain("- BR-1022 [game] [规划中] [生效时改 BR-300] Rule BR-1022");
    expect(prompt).toContain("will_amend: BR-300\n");
  });
});

describe("the landing that activates a rule with will_amend (BR-2496)", () => {
  test("BR-2496 BR-2036: when a planned rule with will_amend becomes active, the review gets each declared target in full, also from another top domain, and is asked to judge them as active rules", () => {
    const root = repo({ "BR-1022.md": rule("BR-1022", "planned", "will_amend: [BR-300]\n") });
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **原因**：拒绝的理由\n\n## 业务\n\n- **x**：y\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), "");
    writeFileSync(join(root, "canon/rules/billing/BR-300.md"), rule("BR-300", "active").replace("Refusal reasons are a and b.", "SENTINEL-target-300: the reasons are alpha and beta only."));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "planned with will_amend");
    const base = sh(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "canon/rules/game/BR-1022.md"), rule("BR-1022", "active").replace("Refusal reasons are a and b.", "Refusal reasons are alpha, beta and gamma."));
    sh(root, "commit", "-qam", "activate without changing BR-300");
    const head = sh(root, "rev-parse", "HEAD");
    const c = corpus(root);
    const scope = reviewScope(root, base, head, c);
    expect(scope.activated).toEqual([{ id: "BR-1022", targets: ["BR-300"] }]);
    const parts = reviewPromptParts(root, c, scope.changedDocs, { activated: scope.activated }, 250 * 1024);
    if (!parts.ok) throw new Error(parts.error.message);
    const all = parts.value.prompts.join("\n");
    expect(all).toContain("# BR-1022 becomes active in this landing; while planned it declared it would change BR-300");
    expect(all).toContain("SENTINEL-target-300");
    // a rule that stays planned, or was never planned, activates nothing
    expect(reviewScope(root, head, head, c).activated).toEqual([]);
  });

  test("BR-2496: a rule moved to another domain in the landing that activates it is still found by its id", () => {
    const root = repo({ "BR-1022.md": rule("BR-1022", "planned", "will_amend: [BR-300]\n"), "BR-300.md": rule("BR-300", "active") });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "planned with will_amend");
    const base = sh(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "canon/rules/game/shipping"), { recursive: true });
    writeFileSync(join(root, "canon/rules/game/shipping/README.md"), "# shipping\n\n## 术语\n\n- **原因**：拒绝的理由\n\n## 业务\n\n- **x**：y\n");
    sh(root, "rm", "-q", "canon/rules/game/BR-1022.md");
    writeFileSync(join(root, "canon/rules/game/shipping/BR-1022.md"), rule("BR-1022", "active"));
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "activate and move");
    const head = sh(root, "rev-parse", "HEAD");
    expect(reviewScope(root, base, head, corpus(root)).activated).toEqual([{ id: "BR-1022", targets: ["BR-300"] }]);
  });
});
