import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, sh, startNew, ws } from "../../testkit.ts";

// reason: each case lands two changes in process; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(120_000);

// A test file is a shell script that writes a one-case JUnit report to $1; t/shared.sh fails only when both lib files exist.
const report = `printf '<testsuites><testsuite name="s"><testcase name="works" classname="" /></testsuite></testsuites>' > "$1"`;
const PASS = `#!/bin/sh\n${report}\nexit 0\n`;
const SHARED = `#!/bin/sh\n${report}\nif [ -e src/lib-a.txt ] && [ -e src/lib-b.txt ]; then echo 'lib a and lib b clash'; exit 1; fi\nexit 0\n`;
// src/<name>.txt selects t/<name>.sh; any path with lib- in it also selects t/shared.sh.
const SELECT = 'while read p; do n=$(basename "$p" .txt); case "$p" in src/lib-*) echo "t/shared.sh\tlib";; src/*) echo "t/$n.sh\tsame name";; esac; done\n';

function fixture(policies = "") {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: ["t/*.sh"]\ntest_command: "sh {file} {report}"\ntest_select_command: "sh select.sh"\nreview: none\n${policies}`);
  mkdirSync(join(root, "t"), { recursive: true });
  for (const n of ["x", "y"]) writeFileSync(join(root, `t/${n}.sh`), PASS);
  writeFileSync(join(root, "t/shared.sh"), SHARED);
  writeFileSync(join(root, "select.sh"), SELECT);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}
function change(root: string, title: string, files: Record<string, string>) {
  const s = startNew(root, title);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(s.worktree, path, ".."), { recursive: true });
    writeFileSync(join(s.worktree, path), text);
  }
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", title);
  return s;
}
async function landing(wt: string) {
  const said: string[] = [];
  const r = await land(ws(wt), FAST, (l) => said.push(l));
  return { r, said, cross: said.filter((l) => l.startsWith("cross tests:")) };
}

describe("cross tests when a branch and what main gained since it forked overlap (BR-2645)", () => {
  test("BR-2645: a test test_select_command picks for both sides runs on the tree being landed; it fails there, so the landing is refused naming it and main stays", async () => {
    const root = fixture();
    const a = change(root, "A", { "src/lib-a.txt": "a\n" });
    const b = change(root, "B", { "src/lib-b.txt": "b\n" });
    const first = await landing(b.worktree);
    expect(first.r.kind).toBe("landed");
    expect(first.cross).toEqual([]);
    const before = sh(root, "rev-parse", "main").trim();
    const second = await landing(a.worktree);
    expect(second.cross.join("\n")).toContain("test_select_command picks t/shared.sh for both");
    expect(second.r.kind).toBe("refused");
    expect(JSON.stringify(second.r)).toContain("t/shared.sh fails on the tree being landed (BR-2645)");
    expect(JSON.stringify(second.r)).toContain("lib a and lib b clash");
    expect(sh(root, "rev-parse", "main").trim()).toBe(before);
  });

  test("BR-2645: a path both sides changed runs the tests picked for main's side; they pass and the change lands", async () => {
    const root = fixture();
    const a = change(root, "A", { "src/x.txt": "a\n", "src/y.txt": "a\n" });
    const b = change(root, "B", { "src/x.txt": "a\n" });
    expect((await landing(b.worktree)).r.kind).toBe("landed");
    const second = await landing(a.worktree);
    expect(second.cross.join("\n")).toContain("both changed src/x.txt");
    expect(second.said).toContain("cross-tested t/x.sh: pass");
    expect(second.r.kind).toBe("landed");
  });

  test("BR-2645: with no shared path and no shared test, nothing extra runs and the change lands", async () => {
    const root = fixture();
    const a = change(root, "A", { "src/x.txt": "a\n" });
    const b = change(root, "B", { "src/y.txt": "b\n" });
    expect((await landing(b.worktree)).r.kind).toBe("landed");
    const second = await landing(a.worktree);
    expect(second.r.kind).toBe("landed");
    expect(second.cross).toEqual([]);
    expect(second.said.some((l) => l.startsWith("cross-tested"))).toBe(false);
  });

  test("BR-2645: policies.landing.cross_tests false on main skips the step; a branch setting it for itself does not", async () => {
    const off = fixture("policies:\n  landing:\n    cross_tests: false\n");
    const a = change(off, "A", { "src/lib-a.txt": "a\n" });
    const b = change(off, "B", { "src/lib-b.txt": "b\n" });
    expect((await landing(b.worktree)).r.kind).toBe("landed");
    const skipped = await landing(a.worktree);
    expect(skipped.cross).toEqual([]);
    expect(skipped.r.kind).toBe("landed");

    const on = fixture();
    const c = change(on, "C", { "src/lib-a.txt": "a\n" });
    const cfg = join(c.worktree, "canon/config.yaml");
    writeFileSync(cfg, `${sh(c.worktree, "show", "HEAD:canon/config.yaml").trimEnd()}\npolicies:\n  landing:\n    cross_tests: false\n`);
    sh(c.worktree, "commit", "-qam", "switch cross tests off for itself");
    const d = change(on, "D", { "src/lib-b.txt": "b\n" });
    expect((await landing(d.worktree)).r.kind).toBe("landed");
    const own = await landing(c.worktree);
    expect(own.cross.join("\n")).toContain("t/shared.sh");
    expect(own.r.kind).toBe("refused");
  });
});
