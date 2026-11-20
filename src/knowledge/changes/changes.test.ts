import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocFile } from "../documents/docfile.ts";
import { land } from "../../work/land/land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";

// reason: each case spawns canon or makes worktrees; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 教训\n\n无。\n";
/** A change file with front matter lines `extra` (YAML, one key per line). */
const change = (n: number, status: string, extra = "") => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\nrules: []\n${extra}---\n${BODY}`;
const release = (n: number, features = "[]") => `---\nid: R-${n}\ntitle: Release ${n}\nstatus: planned\nfeatures: ${features}\n---\n\n## 目标\n\nx\n\n## 用户\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\nx\n\n## 故事地图切片\n\nx\n`;
const feature = (n: number) => `---\nid: F-${n}\ntitle: Feature ${n}\nstatus: active\n---\n\n## 目标\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\nx\n`;

/** A project whose main has `files` (path under canon/ → text) committed. */
function repo(files: Record<string, string>): string {
  const root = project();
  write(root, files);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, "canon", p, ".."), { recursive: true });
    writeFileSync(join(root, "canon", p), text);
  }
}

const checkLines = (root: string) => cli(root, "check").out.split("\n").filter((l) => /^[a-z-]+\s+canon\//.test(l));
const metaIn = (dir: string, id: string): Record<string, unknown> => {
  const file = readdirSync(join(dir, "canon/changes")).find((f) => f === `${id}.md` || f.startsWith(`${id}-`))!;
  const parsed = parseDocFile(readFileSync(join(dir, "canon/changes", file), "utf8"), file);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.meta;
};
const newId = (out: string) => out.match(/canon\/changes\/(C-\d+)/)?.[1] ?? out.match(/(C-\d+) →/)![1]!;

describe("a change's links in canon check", () => {
  test("BR-2561 BR-2386: release or feature alone, issues and depends_on of the right shape, done_by on a dropped change: no finding, a release on a change without a plan included", () => {
    const root = repo({
      "releases/R-1.md": release(1, "[F-3]"),
      "features/F-3.md": feature(3),
      "changes/C-2.md": change(2, "open", "release: R-1\nissues: [12, 40]\ndepends_on: [C-1]\n"),
      "changes/C-3.md": change(3, "open", "feature: F-3\n"),
      "changes/C-4.md": change(4, "dropped", "done_by: C-3\n"),
      "changes/C-5.md": change(5, "open"),
    });
    // C-1 exists only on its own branch: a dependency on it is not a dangling reference (D-149)
    sh(root, "branch", "change/C-1");
    expect(checkLines(root)).toEqual([]);
  });

  test("BR-2561: both release and feature, done_by on an open change or on itself are file-invalid; a feature that does not exist is ref-dangling", () => {
    const root = repo({
      "releases/R-1.md": release(1),
      "changes/C-2.md": change(2, "open", "release: R-1\nfeature: F-9\n"),
      "changes/C-3.md": change(3, "open", "done_by: C-5\n"),
      "changes/C-4.md": change(4, "dropped", "done_by: C-4\n"),
    });
    const lines = checkLines(root);
    expect(lines.filter((l) => l.includes("C-2.md")).map((l) => l.split(/\s+/)[0])).toEqual(["file-invalid", "ref-dangling"]);
    expect(lines.find((l) => l.startsWith("file-invalid") && l.includes("C-2.md"))).toMatch(/`release: R-1`.*`feature: F-9`/);
    expect(lines.find((l) => l.startsWith("ref-dangling") && l.includes("C-2.md"))).toContain("F-9");
    expect(lines.filter((l) => l.includes("C-3.md"))).toEqual([expect.stringMatching(/^file-invalid .*done_by/)]);
    expect(lines.filter((l) => l.includes("C-4.md"))).toEqual([expect.stringMatching(/^file-invalid .*names itself/)]);
  });

  test("BR-2561: a link of the wrong shape makes the change file unreadable, naming the key", () => {
    for (const [extra, key] of [["feature: 3\n", "feature"], ["issues: [0]\n", "issues"], ['issues: ["#12"]\n', "issues"], ["depends_on: C-1\n", "depends_on"], ["done_by: 7\n", "done_by"]] as const) {
      const root = repo({ "changes/C-2.md": change(2, "dropped", extra) });
      const lines = checkLines(root);
      expect([extra, lines.length]).toEqual([extra, 1]);
      expect(lines[0]).toMatch(new RegExp(`^file-invalid .*\`${key}\``));
    }
  });

  test("BR-2561: a declared type may not use a link key as a field", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\nreview: none\ntypes:\n  spec:\n    prefix: SP\n    dir: specs\n    fields: [depends_on]\n");
    const r = cli(root, "check");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("depends_on");
  });
});

describe("links written by the commands that create a change", () => {
  test("BR-2562: canon change new writes release or feature, issues and depends_on, makes no worktree; started later the links stay", () => {
    const root = repo({ "releases/R-1.md": release(1, "[F-2]"), "features/F-2.md": feature(2), "changes/C-3.md": change(3, "open") });
    const r = cli(root, "change", "new", "--title", "导出", "--feature", "f-2", "--issue", "12,#40", "--depends", "C-3");
    expect(r.code).toBe(0);
    const id = newId(r.out);
    expect(metaIn(root, id)).toMatchObject({ status: "open", feature: "F-2", issues: [12, 40], depends_on: ["C-3"] });
    expect(metaIn(root, id)["release"]).toBeUndefined();
    expect(sh(root, "worktree", "list").split("\n")).toHaveLength(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "the change created ahead lands");
    const s = cli(root, "work", "start", id);
    expect(s.code).toBe(0);
    const wt = s.out.match(/cd (.+)/)![1]!.trim();
    expect(metaIn(wt, id)).toMatchObject({ feature: "F-2", issues: [12, 40], depends_on: ["C-3"] });
  });

  test("BR-2562: canon work start --title writes the links into the commit that opens it; a dependency only on a branch is accepted", () => {
    const root = repo({ "releases/R-1.md": release(1) });
    const first = startNew(root, "On a branch");
    const r = cli(root, "work", "start", "--title", "Export", "--release", "R-1", "--depends", first.change);
    expect(r.code).toBe(0);
    const id = newId(r.out);
    const wt = r.out.match(/cd (.+)/)![1]!.trim();
    const file = sh(wt, "show", "--name-only", "--format=", "HEAD").split("\n").find((f) => f.includes(id))!;
    const meta = parseDocFile(sh(wt, "show", `HEAD:${file}`), file);
    expect(meta.ok && meta.value.meta).toMatchObject({ release: "R-1", depends_on: [first.change] });
    const plain = cli(root, "work", "start", "--title", "Plain");
    const pid = newId(plain.out);
    const meta2 = metaIn(plain.out.match(/cd (.+)/)![1]!.trim(), pid);
    for (const k of ["release", "feature", "issues", "depends_on"]) expect([k, meta2[k]]).toEqual([k, undefined]);
  });

  test("BR-2562: usage errors exit 2, a release, feature or dependency that is nowhere exits 3; nothing is made or numbered", () => {
    const root = repo({ "releases/R-1.md": release(1), "changes/C-7.md": change(7, "open") });
    const before = readdirSync(join(root, "canon/changes")).length;
    for (const [args, code] of [
      [["change", "new", "--title", "x", "--release", "R-1", "--feature", "F-2"], 2],
      [["change", "new", "--title", "x", "--issue", "abc"], 2],
      [["change", "new", "--title", "x", "--depends", "X-1"], 2],
      [["work", "start", "C-7", "--release", "R-1"], 2],
      [["work", "start", "--fix-main", "--issue", "3"], 2],
      [["work", "start", "--title", "x", "--depends", "C-99"], 3],
      [["work", "start", "--title", "x", "--release", "R-9"], 3],
      [["change", "new", "--title", "x", "--feature", "F-2"], 3],
    ] as const) {
      const r = cli(root, ...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), code]);
    }
    expect(r99(root)).toContain("C-99");
    expect(readdirSync(join(root, "canon/changes")).length).toBe(before);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    // no number was taken: the next change is C-8
    expect(newId(cli(root, "change", "new", "--title", "next").out)).toBe("C-8");
  });
});

const r99 = (root: string) => cli(root, "work", "start", "--title", "x", "--depends", "C-99").err;

describe("canon change link", () => {
  test("BR-2563: replaces the given links, keeps one of release and feature, removes one with none, and records change.link", () => {
    const root = repo({ "releases/R-1.md": release(1, "[F-2]"), "features/F-2.md": feature(2), "changes/C-2.md": change(2, "open"), "changes/C-3.md": change(3, "open"), "changes/C-4.md": change(4, "open"), "changes/C-9.md": change(9, "open", "release: R-1\nissues: [5]\ndepends_on: [C-2]\n") });
    const r = cli(root, "change", "link", "C-9", "--feature", "F-2");
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("C-9 →");
    expect(metaIn(root, "C-9")).toMatchObject({ feature: "F-2", issues: [5], depends_on: ["C-2"] });
    expect(metaIn(root, "C-9")["release"]).toBeUndefined();
    expect(cli(root, "change", "link", "C-9", "--depends", "C-3,C-4").code).toBe(0);
    expect(metaIn(root, "C-9")["depends_on"]).toEqual(["C-3", "C-4"]);
    expect(cli(root, "change", "link", "C-9", "--issue", "none").code).toBe(0);
    expect(metaIn(root, "C-9")["issues"]).toBeUndefined();
    const events = ws(root).db.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'change.link' AND subject = 'C-9'").get()!;
    expect(events.n).toBe(3);
  });

  test("BR-2563: done_by goes on a dropped change only; a wrong status, no argument, a missing change, or a cycle changes nothing", () => {
    const root = repo({ "changes/C-3.md": change(3, "open", "depends_on: [C-9]\n"), "changes/C-5.md": change(5, "dropped"), "changes/C-6.md": change(6, "open"), "changes/C-8.md": change(8, "done"), "changes/C-9.md": change(9, "open") });
    expect(cli(root, "change", "link", "C-5", "--done-by", "C-9").code).toBe(0);
    expect(metaIn(root, "C-5")["done_by"]).toBe("C-9");
    const before = () => readdirSync(join(root, "canon/changes")).map((f) => readFileSync(join(root, "canon/changes", f), "utf8")).join("\n");
    const was = before();
    expect(cli(root, "change", "link", "C-6", "--done-by", "C-9").code).toBe(2);
    expect(cli(root, "change", "link", "C-8", "--issue", "1").code).toBe(2);
    expect(cli(root, "change", "link", "C-9").code).toBe(2);
    expect(cli(root, "change", "link", "C-5", "--done-by", "C-5").code).toBe(2);
    expect(cli(root, "change", "link", "C-77", "--issue", "1").code).toBe(3);
    expect(cli(root, "change", "link", "C-9", "--depends", "C-99").code).toBe(3);
    const cycle = cli(root, "change", "link", "C-9", "--depends", "C-3");
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("C-9 → C-3 → C-9");
    expect(before()).toBe(was);
  });

  test("BR-2563: in the primary checkout a change only on its own branch is not found", () => {
    const root = project();
    const s = startNew(root, "Only on a branch");
    expect(cli(root, "change", "link", s.change, "--issue", "1").code).toBe(3);
  });
});

describe("dependencies not satisfied are not offered to start", () => {
  const listed = (root: string) => cli(root, "change", "list").out;
  const line = (out: string, id: string) => out.split("\n").find((l) => l.startsWith(`${id} `)) ?? "";
  const json = (root: string, id: string) => (JSON.parse(cli(root, "change", "list", "--json").out) as { id: string; waiting_for: unknown[] }[]).find((c) => c.id === id)!.waiting_for;

  test("BR-2564 BR-2505: an open dependency marks the change waiting in change list and the overview and keeps it off the brief's line to take; once it lands done it is ready", () => {
    const root = repo({ "changes/C-3.md": change(3, "open"), "changes/C-5.md": change(5, "open", "depends_on: [C-3]\n"), "changes/C-6.md": change(6, "open") });
    expect(line(listed(root), "C-5")).toContain("(waiting-deps; waiting for C-3)");
    expect(json(root, "C-5")).toEqual([{ id: "C-3", state: "open" }]);
    expect(json(root, "C-6")).toEqual([]);
    const brief = cli(root, "brief").out;
    const take = brief.split("\n").find((l) => l.includes("take the first unclaimed"))!;
    expect(take).toContain("C-6");
    expect(take).not.toContain("C-5");
    expect(brief).toContain("Waiting for dependencies, not ready to start: C-5 (waiting for C-3)");
    expect(brief).toContain("not marked claimed, ambiguous or waiting");
    expect(cli(root, "overview").out).toContain("C-5 Change 5  waiting-deps: C-3");
    write(root, { "changes/C-3.md": change(3, "done") });
    sh(root, "commit", "-qam", "C-3 lands");
    expect(line(listed(root), "C-5")).not.toContain("waiting for");
    expect(cli(root, "brief").out.split("\n").find((l) => l.includes("take the first unclaimed"))).toContain("C-5");
    expect(cli(root, "overview").out).not.toContain("waiting-deps");
  });

  test("BR-2564: a dependency only on a branch, even done there, waits as on-branch; a dropped one counts as its done_by", () => {
    const root = repo({
      "changes/C-4.md": change(4, "dropped", "done_by: C-8\n"),
      "changes/C-8.md": change(8, "done"),
      "changes/C-10.md": change(10, "dropped", "done_by: C-11\n"),
      "changes/C-11.md": change(11, "open"),
      "changes/C-12.md": change(12, "dropped"),
      "changes/C-13.md": change(13, "dropped", "done_by: C-14\n"),
      "changes/C-14.md": change(14, "dropped", "done_by: C-13\n"),
    });
    const s = startNew(root, "Done only on its branch");
    const file = sh(s.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(s.change))!;
    writeFileSync(join(s.worktree, file), readFileSync(join(s.worktree, file), "utf8").replace("status: open", "status: done"));
    sh(s.worktree, "commit", "-qam", "done on the branch");
    write(root, {
      "changes/C-20.md": change(20, "open", `depends_on: [${s.change}]\n`),
      "changes/C-21.md": change(21, "open", "depends_on: [C-4]\n"),
      "changes/C-22.md": change(22, "open", "depends_on: [C-10]\n"),
      "changes/C-23.md": change(23, "open", "depends_on: [C-12]\n"),
      "changes/C-24.md": change(24, "open", "depends_on: [C-99]\n"),
      "changes/C-25.md": change(25, "open", "depends_on: [C-13]\n"),
    });
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "dependents");
    const out = listed(root);
    expect(line(out, "C-20")).toContain(`waiting for ${s.change}`);
    expect(json(root, "C-20")).toEqual([{ id: s.change, state: "on-branch" }]);
    expect(line(out, "C-21")).not.toContain("waiting");
    expect(line(out, "C-22")).toContain("waiting for C-10 (done by C-11)");
    expect(line(out, "C-23")).toContain("waiting for C-12 (dropped without done_by)");
    expect(line(out, "C-24")).toContain("waiting for C-99 (not found)");
    expect(json(root, "C-24")).toEqual([{ id: "C-99", state: "not-found" }]);
    expect(line(out, "C-25")).toContain("waiting for C-13 (done by C-14)");
    // waiting is not refusing: the change still starts
    expect(cli(root, "work", "start", "C-23").code).toBe(0);
  });

  test("BR-2564: when every open change waits, the brief has no line to take, only the waiting line", () => {
    const root = repo({ "changes/C-1.md": change(1, "dropped"), "changes/C-5.md": change(5, "open", "depends_on: [C-1]\n") });
    const brief = cli(root, "brief").out;
    expect(brief).not.toContain("take the first unclaimed");
    expect(brief).toContain("Waiting for dependencies, not ready to start: C-5 (waiting for C-1 (dropped without done_by))");
  });
});

describe("dependency cycles", () => {
  test("BR-2565: canon check reports depends-cycle on each change of a cycle, naming the whole cycle; a change off the cycle and a chain are not reported", () => {
    const root = repo({
      "changes/C-1.md": change(1, "open", "depends_on: [C-2]\n"),
      "changes/C-2.md": change(2, "done", "depends_on: [C-1]\n"),
      "changes/C-3.md": change(3, "open", "depends_on: [C-3]\n"),
      "changes/C-4.md": change(4, "open", "depends_on: [C-1]\n"),
      "changes/C-5.md": change(5, "open", "depends_on: [C-6]\n"),
      "changes/C-6.md": change(6, "open", "depends_on: [C-7]\n"),
    });
    const r = cli(root, "check");
    expect(r.code).toBe(1);
    const cycles = r.out.split("\n").filter((l) => l.startsWith("depends-cycle"));
    expect(cycles).toHaveLength(3);
    expect(cycles.find((l) => l.includes("C-1.md"))).toContain("C-1 → C-2 → C-1");
    expect(cycles.find((l) => l.includes("C-2.md"))).toContain("C-2 → C-1 → C-2");
    expect(cycles.find((l) => l.includes("C-3.md"))).toContain("C-3 → C-3");
  });

  test("BR-2565: two branches that each add one edge pass on their own; the second to land is refused after rebase", async () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-2.md": change(2, "open") });
    const a = startNew(root, "Edge one");
    const b = startNew(root, "Edge two");
    write(a.worktree, { "changes/C-1.md": change(1, "open", "depends_on: [C-2]\n") });
    sh(a.worktree, "commit", "-qam", "C-1 depends on C-2");
    write(b.worktree, { "changes/C-2.md": change(2, "open", "depends_on: [C-1]\n") });
    sh(b.worktree, "commit", "-qam", "C-2 depends on C-1");
    expect(cli(b.worktree, "check").out).not.toContain("depends-cycle");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    const out = await land(ws(b.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => f.rule)).toContain("depends-cycle");
  });

  test("BR-2565: a dependency on a change only on another branch is not an edge of this tree", () => {
    const root = repo({ "changes/C-1.md": change(1, "open") });
    const other = startNew(root, "Elsewhere");
    const file = sh(other.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(other.change))!;
    writeFileSync(join(other.worktree, file), readFileSync(join(other.worktree, file), "utf8").replace("rules: []", "rules: []\ndepends_on: [C-1]"));
    sh(other.worktree, "commit", "-qam", "depends on C-1");
    write(root, { "changes/C-1.md": change(1, "open", `depends_on: [${other.change}]\n`) });
    sh(root, "commit", "-qam", "C-1 depends on the branch change");
    expect(cli(root, "check").out).not.toContain("depends-cycle");
  });
});

describe("a dependency on a success criterion", () => {
  const withCriteria = (criteria: string) => `---\nid: R-2\ntitle: Release 2\nstatus: planned\nfeatures: []\n---\n\n## 目标\n\nx\n\n## 用户\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\n${criteria}\n\n## 故事地图切片\n\nx\n`;
  const OWNER = "- S2 规则全过。\n- S3 负责人逐条回答。（待负责人）";

  test("BR-2561: an open change naming a criterion that is not there is ref-dangling; a done one is not checked; a malformed one is file-invalid", () => {
    const root = repo({
      "releases/R-2.md": withCriteria(OWNER),
      "changes/C-4.md": change(4, "open", "depends_on: [R-2/S3]\n"),
      "changes/C-5.md": change(5, "open", "depends_on: [R-2/S8, R-9/S1]\n"),
      "changes/C-6.md": change(6, "done", "depends_on: [R-2/S8]\n"),
    });
    const lines = checkLines(root);
    expect(lines.filter((l) => l.includes("C-4.md") || l.includes("C-6.md"))).toEqual([]);
    expect(lines.filter((l) => l.includes("C-5.md")).map((l) => l.split(/\s+/)[0])).toEqual(["ref-dangling", "ref-dangling"]);
    expect(lines.join("\n")).toContain("R-2/S8");
    expect(lines.join("\n")).toContain("R-9/S1");
    const bad = repo({ "changes/C-2.md": change(2, "open", "depends_on: [R-1/2]\n") });
    expect(checkLines(bad)).toEqual([expect.stringMatching(/^file-invalid .*`depends_on`/)]);
  });

  test("BR-2562: --depends takes a criterion that exists and refuses one that does not with exit 3", () => {
    const root = repo({ "releases/R-2.md": withCriteria(OWNER) });
    const r = cli(root, "change", "new", "--title", "跟进", "--depends", "r-2/s3");
    expect(r.code).toBe(0);
    expect(metaIn(root, newId(r.out))["depends_on"]).toEqual(["R-2/S3"]);
    const missing = cli(root, "change", "new", "--title", "x", "--depends", "R-2/S8");
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("R-2/S8");
    expect(cli(root, "work", "start", "--title", "x", "--depends", "R-2/S8").code).toBe(3);
  });

  test("BR-2564: a criterion waiting for the owner keeps the change waiting with its text even after the checklist lands; met on main it is ready", () => {
    const root = repo({ "releases/R-2.md": withCriteria(OWNER), "changes/C-5.md": change(5, "done"), "changes/C-6.md": change(6, "open", "depends_on: [R-2/S3, R-2/S8]\n") });
    const line = cli(root, "change", "list").out.split("\n").find((l) => l.startsWith("C-6 "))!;
    expect(line).toContain("waiting for R-2/S3: 负责人逐条回答。, R-2/S8 (not found)");
    const json = (JSON.parse(cli(root, "change", "list", "--json").out) as { id: string; waiting_for: unknown[] }[]).find((c) => c.id === "C-6")!.waiting_for;
    expect(json).toEqual([{ id: "R-2/S3", state: "owner", text: "负责人逐条回答。" }, { id: "R-2/S8", state: "not-found" }]);
    write(root, { "releases/R-2.md": withCriteria("- S2 规则全过。\n- S3 负责人逐条回答。（已满足：C-5）"), "changes/C-6.md": change(6, "open", "depends_on: [R-2/S3]\n") });
    sh(root, "commit", "-qam", "the owner answered");
    expect(cli(root, "change", "list").out.split("\n").find((l) => l.startsWith("C-6 "))).not.toContain("waiting");
  });

  test("BR-2565: a criterion in depends_on is no edge of a cycle", () => {
    const root = repo({ "releases/R-2.md": withCriteria(OWNER), "changes/C-4.md": change(4, "open", "depends_on: [R-2/S3, C-5]\n"), "changes/C-5.md": change(5, "open", "depends_on: [R-2/S3]\n") });
    expect(cli(root, "check").out).not.toContain("depends-cycle");
  });
});
