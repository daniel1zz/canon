import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";
import { recordReport } from "../../work/verify/ledger.ts";
import { readCorpus } from "../documents/read.ts";
import { namedTests } from "./named-tests.ts";
import { reviewPrompt } from "./review.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const br = (n: number) => ["BR", n].join("-");
const rule = (n: number, title: string, text: string) => `---\nid: ${br(n)}\ntitle: ${title}\nstatus: active\nuntested: fixture\n---\n\n## 规则\n\n${text}\n\n## 例子\n\n- x → y\n`;

/** work: BR-1 (the changed one), BR-2 naming it; work/sub: BR-3 that neither names it nor shares its words; a test file. */
function repo(extra: Record<string, string> = {}) {
  const root = project();
  roots.push(root);
  const files: Record<string, string> = {
    "canon/config.yaml": "floor: test ! -e FAIL\ntests: [\"src/**/*.test.ts\"]\nreview: none\n",
    "canon/rules/work/README.md": "# work\n\nWORK-README.\n",
    "canon/rules/work/sub/README.md": "# work/sub\n\nSUB-README.\n",
    [`canon/rules/work/${br(1)}.md`]: rule(1, "Queue landings", "Landings queue in arrival order."),
    [`canon/rules/work/${br(2)}.md`]: rule(2, "Retry a landing", `NEIGHBOUR-TEXT: a refused landing is retried as ${br(1)} queues it.`),
    [`canon/rules/work/sub/${br(3)}.md`]: rule(3, "Archive snapshots", "FAR-TEXT: zebra quokka narwhal."),
    "src/a.test.ts": "// fixture\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  const w = ws(root);
  return { root, w, corpus: readCorpus(root, w.config.types, w.config).corpus };
}
const domainPart = (prompt: string) => {
  const from = prompt.indexOf("# Current context for ");
  return from < 0 ? "" : prompt.slice(from, prompt.indexOf("\n# Rule index (every", from));
};

test("BR-2009: the domain part shows the changed rule's neighbours, not the rest of its top-level domain, which stays in the rule index", () => {
  const { root, corpus } = repo();
  const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === br(1)));
  expect(domainPart(prompt)).toContain("NEIGHBOUR-TEXT");
  expect(domainPart(prompt)).toContain("WORK-README.");
  expect(domainPart(prompt)).not.toContain("FAR-TEXT");
  expect(domainPart(prompt)).not.toContain("SUB-README.");
  expect(prompt).toMatch(new RegExp(`^- ${br(3)} \\[work/sub\\] Archive snapshots$`, "m"));
});

test("BR-2009: a landing that changes a domain's README gives all of that domain's rules", () => {
  const { root, corpus } = repo();
  const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === br(1)), { readmes: ["work/sub"] });
  expect(domainPart(prompt)).toContain("FAR-TEXT");
  expect(domainPart(prompt)).toContain("SUB-README.");
});

test("BR-2009: the review lists the running tests that name each changed rule from the recorded reports, and says when none does (#265)", () => {
  const { root, w, corpus } = repo({ [`canon/rules/work/${br(4)}.md`]: rule(4, "Untested one", "Nothing names it.") });
  const blob = sh(root, "hash-object", "src/a.test.ts");
  recordReport(w.db, "src/a.test.ts", blob, [
    { suites: [], classname: "", name: `${br(1)}: landings queue in arrival order`, runs: true },
    { suites: [], classname: "", name: `${br(4)}: a skipped one`, runs: false },
  ], "test_command");
  const tests = namedTests(w.db, root, w.config, [br(1), br(4)]);
  expect([...tests.keys()]).toEqual([br(1)]);
  const prompt = reviewPrompt(root, corpus, corpus.docs.filter((d) => d.id === br(1) || d.id === br(4)), { tests });
  expect(prompt).toContain(`## ${br(1)}: 1 test(s)\n- src/a.test.ts: ${br(1)}: landings queue in arrival order`);
  expect(prompt).toContain(`## ${br(4)}: no running test names it`);
  expect(prompt).toContain("never call it untestable for want of a test");
});
