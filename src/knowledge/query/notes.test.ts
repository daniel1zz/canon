import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, ws } from "../../work/testkit.ts";

/** The open review notes `canon context` prints, driven through the real command line (BR-2146). */
const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const id = (prefix: string, n: number) => [prefix, n].join("-");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const rule = (n: number) => `---\nid: ${id("BR", n)}\ntitle: Rule ${n}\nstatus: active\nuntested: fixture\n---\n## 规则\n\nx.\n`;

/** code_root src: work, work/drop (BR-1), work/land (BR-2) and billing (BR-5); src/work/drop/drop.ts imports work/land's and billing's code. */
function fixture() {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\ncode_root: src\n");
  const files: Record<string, string> = {
    "canon/rules/work/README.md": "# work\n\nWork.\n",
    "canon/rules/work/drop/README.md": "# work/drop\n\nDropping.\n",
    "canon/rules/work/land/README.md": "# work/land\n\nLanding.\n",
    [`canon/rules/work/drop/${id("BR", 1)}.md`]: rule(1),
    [`canon/rules/work/land/${id("BR", 2)}.md`]: rule(2),
    "canon/rules/billing/README.md": "# billing\n\nMoney.\n",
    [`canon/rules/billing/${id("BR", 5)}.md`]: rule(5),
    "src/work/drop/drop.ts": 'import { land } from "../land/land.ts";\nimport { pay } from "../../billing/pay.ts";\n',
    "src/billing/pay.ts": "export const pay = 1;\n",
    "src/work/land/land.ts": "export const land = 1;\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

describe("open review notes in context", () => {
  test("BR-2146: the rules of an imported domain, listed by title, bring their open notes too", () => {
    const root = fixture();
    const out0 = canon(root, "context", "src/work/drop/drop.ts").out;
    expect(out0).toContain(`# Imported domain: work/land`);
    expect(out0).not.toContain("Open review notes");
    expect(out0).toContain("Imported from other domains, not included: billing (src/billing/pay.ts)");
    ws(root).db.event("agent:x", "land.ok", id("C", 9), { reviewed: [id("BR", 2), id("BR", 5)], notes: ["例子缺少边界另一侧"] });
    const out = canon(root, "context", "src/work/drop/drop.ts").out;
    expect(out).toContain(`- ${id("BR", 2)}: 例子缺少边界另一侧 (${id("C", 9)}, `);
    expect(out).not.toContain(`- ${id("BR", 5)}:`); // another top-level domain is named only, so are its notes
  });

  test("BR-2146: each note is one line with the id, the note, the change and the date; without a change only the date", () => {
    const root = fixture();
    const db = ws(root).db;
    db.event("agent:x", "land.ok", id("C", 9), { reviewed: [id("BR", 1)], notes: ["例子缺少边界另一侧"] });
    db.event("agent:x", "land.ok", null, { reviewed: [id("BR", 2)], notes: ["措辞可以更短"] });
    const out = canon(root, "context", "work").out;
    expect(out).toContain("# Open review notes\n\nNot blocking and not changes of their own: handle them when you change the document they name.\n");
    expect(out).toMatch(new RegExp(`\\n- ${id("BR", 1)}: 例子缺少边界另一侧 \\(${id("C", 9)}, \\d{4}-\\d{2}-\\d{2}\\)\\n`));
    expect(out).toMatch(new RegExp(`\\n- ${id("BR", 2)}: 措辞可以更短 \\(\\d{4}-\\d{2}-\\d{2}\\)\\n`));
  });
});
