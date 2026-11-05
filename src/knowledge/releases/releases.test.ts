import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh } from "../../work/testkit.ts";
import { behaviourHash } from "../documents/behaviour.ts";

// reason: each case spawns canon several times; a loaded machine took longer than bun's 5 s default (as in documents.test.ts)
setDefaultTimeout(30_000);

const MAIN = join(import.meta.dir, "..", "..", "cli", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const BR = (n: number) => id("BR", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** A canon finding line of `canon check`: its check name, the file and the message. */
function findings(root: string): { rule: string; path: string; message: string }[] {
  return canon(root, "check")
    .out.split("\n")
    .map((l) => /^([a-z-]+)\s+(\S+?): (.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && m[1] !== "note")
    .map((m) => ({ rule: m[1]!, path: m[2]!, message: m[3]! }));
}

const SECTIONS = ["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"];
const releaseBody = (extra: Partial<Record<string, string>> = {}) => SECTIONS.map((s) => `## ${s}\n\n${extra[s] ?? `${s}的内容`}\n`).join("\n");
const releaseFile = (n: number, front: Record<string, string>, extra: Partial<Record<string, string>> = {}) =>
  `---\nid: ${R(n)}\ntitle: 版本 ${n}\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${releaseBody(extra)}`;
const ruleFile = (n: number, front: Record<string, string> = {}, status = "active") =>
  `---\nid: ${BR(n)}\ntitle: 规则 ${n}\nstatus: ${status}\nuntested: fixture\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n## 规则\n\n规则 ${n} 的行为。\n\n## 例子\n\n- 输入 → 结果\n`;
const rulePath = (n: number) => `canon/rules/billing/${BR(n)}.md`;
const releasePath = (n: number) => `canon/releases/${R(n)}.md`;

/** A repository with a billing domain, committed; `files` are written on top and committed too. */
function fixture(files: Record<string, string> = {}): string {
  const root = project();
  write(root, {
    "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "src/billing/.keep": "",
    ...files,
  });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  return root;
}

const commit = (root: string, message = "edit") => {
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", message);
  return sh(root, "rev-parse", "HEAD").trim();
};

describe("canon release new and list", () => {
  test("BR-2319: new allocates the next number, writes status planned and the six sections; a Chinese title has no slug; numbers are not reused", () => {
    const root = fixture();
    const first = canon(root, "release", "new", "--title", "MVP");
    expect([first.code, first.out.trim()]).toEqual([0, `canon/releases/${R(1)}-mvp.md`]);
    const text = readFileSync(join(root, `canon/releases/${R(1)}-mvp.md`), "utf8");
    expect(text).toContain(`id: ${R(1)}`);
    expect(text).toContain("status: planned");
    for (const s of SECTIONS) expect(text).toContain(`## ${s}\n`);
    expect(canon(root, "release", "new", "--title", "第一版").out.trim()).toBe(`canon/releases/${R(2)}.md`);
    rmSync(join(root, `canon/releases/${R(2)}.md`));
    expect(canon(root, "release", "new", "--title", "第三版").out.trim()).toBe(`canon/releases/${R(3)}.md`);
  });

  test("BR-2319: a release that is still the template is template-unfilled; an empty title is exit 2 and writes nothing", () => {
    const root = fixture();
    canon(root, "release", "new", "--title", "MVP");
    expect(findings(root).map((f) => f.rule)).toContain("template-unfilled");
    const empty = canon(root, "release", "new", "--title", "  ");
    expect(empty.code).toBe(2);
    expect(existsSync(join(root, `canon/releases/${R(2)}.md`))).toBe(false);
  });

  test("BR-2320: list shows what is not shipped in numeric order, --all adds shipped ones, --json has no bodies, none says so", () => {
    const sha = "a".repeat(40);
    const root = fixture({
      [releasePath(2)]: releaseFile(2, { status: "planned" }),
      [releasePath(10)]: releaseFile(10, { status: "active" }),
      [releasePath(1)]: releaseFile(1, { status: "shipped", shipped_at: sha }),
    });
    const list = canon(root, "release", "list").out.trim().split("\n").map((l) => l.split(/\s+/).slice(0, 2).join(" "));
    expect(list).toEqual([`${R(2)} planned`, `${R(10)} active`]);
    expect(canon(root, "release", "list", "--all").out.trim().split("\n").map((l) => l.split(/\s+/).slice(0, 2).join(" "))).toEqual([`${R(1)} shipped`, `${R(2)} planned`, `${R(10)} active`]);
    const json = JSON.parse(canon(root, "release", "list", "--all", "--json").out) as { id: string; body?: string; shippedAt?: string }[];
    expect(json.map((r) => r.id)).toEqual([R(1), R(2), R(10)]);
    expect(json.every((r) => r.body === undefined)).toBe(true);
    const none = canon(fixture(), "release", "list");
    expect([none.code, none.out.trim()]).toEqual([0, "(no releases)"]);
  });
});

describe("release files and rule tags", () => {
  test("BR-2321: status values and shipped_at are checked; an invalid release is file-invalid and counts as absent for references", () => {
    const sha = "b".repeat(40);
    const ok = fixture({ [releasePath(1)]: releaseFile(1, { status: "active" }), [releasePath(2)]: releaseFile(2, { status: "shipped", shipped_at: sha }) });
    // R-2 is shipped at a commit that does not hold it; that is BR-2325's finding, not a file problem
    expect(findings(ok).filter((f) => f.rule === "file-invalid")).toEqual([]);
    const bad = fixture({
      [releasePath(1)]: releaseFile(1, { status: "shipped" }),
      [releasePath(2)]: releaseFile(2, { status: "shipped", shipped_at: "abc123" }),
      [releasePath(3)]: releaseFile(3, { status: "active", shipped_at: sha }),
      [releasePath(4)]: releaseFile(4, { status: "done" }),
    });
    const invalid = findings(bad).filter((f) => f.rule === "file-invalid");
    expect(invalid.map((f) => f.path).sort()).toEqual([1, 2, 3, 4].map(releasePath).sort());
    const byPath = Object.fromEntries(invalid.map((f) => [f.path, f.message]));
    expect(byPath[releasePath(1)]).toContain("needs `shipped_at`");
    expect(byPath[releasePath(2)]).toContain("40-character");
    expect(byPath[releasePath(3)]).toContain("only for a shipped release");
    expect(byPath[releasePath(4)]).toContain("planned, active, shipped");
  });

  test("BR-2321: a release without a status is planned", () => {
    const root = fixture({ [releasePath(1)]: releaseFile(1, {}) });
    expect(canon(root, "release", "list").out).toMatch(new RegExp(`^${R(1)}\\s+planned\\s`));
  });

  test("BR-2322: release and changed_in must be release ids, changed_in only next to release; either may be left out", () => {
    const good = fixture({
      [releasePath(1)]: releaseFile(1, { status: "active" }),
      [releasePath(2)]: releaseFile(2, { status: "planned" }),
      [releasePath(3)]: releaseFile(3, { status: "planned" }),
      [rulePath(1)]: ruleFile(1, { release: R(1) }),
      [rulePath(2)]: ruleFile(2, { release: R(1), changed_in: `[${R(2)}, ${R(3)}]` }),
      [rulePath(3)]: ruleFile(3),
    });
    expect(findings(good)).toEqual([]);
    const bad = fixture({
      [rulePath(1)]: ruleFile(1, { release: `[${R(1)}, ${R(2)}]` }),
      [rulePath(2)]: ruleFile(2, { release: "v1" }),
      [rulePath(3)]: ruleFile(3, { changed_in: `[${R(2)}]` }),
      [rulePath(4)]: ruleFile(4, { release: R(1), changed_in: "[]" }),
    });
    const invalid = findings(bad).filter((f) => f.rule === "file-invalid");
    expect(invalid.map((f) => f.path).sort()).toEqual([1, 2, 3, 4].map(rulePath).sort());
    expect(invalid.find((f) => f.path === rulePath(3))!.message).toContain("needs `release`");
  });

  test("BR-2323: a tag that names no release is ref-dangling and says which key; an unreadable release does not exist", () => {
    const root = fixture({
      [releasePath(1)]: releaseFile(1, { status: "active" }),
      [rulePath(1)]: ruleFile(1, { release: R(1) }),
      [rulePath(2)]: ruleFile(2, { release: R(9) }),
      [rulePath(3)]: ruleFile(3, { release: R(1), changed_in: `[${R(9)}]` }),
      [releasePath(5)]: releaseFile(5, { status: "done" }),
      [rulePath(4)]: ruleFile(4, { release: R(5) }),
    });
    const dangling = findings(root).filter((f) => f.rule === "ref-dangling");
    expect(dangling.map((f) => [f.path, f.message.includes("`release`") ? "release" : f.message.includes("`changed_in`") ? "changed_in" : "?", f.message.includes(R(9)) || f.message.includes(R(5))])).toEqual([
      [rulePath(2), "release", true],
      [rulePath(3), "changed_in", true],
      [rulePath(4), "release", true],
    ]);
    expect(findings(root).filter((f) => f.rule === "file-invalid").map((f) => f.path)).toEqual([releasePath(5)]);
  });

  test("BR-2324: a release tag changes no behaviour hash, so a passed rule stays passed", () => {
    const rule = (front: Record<string, string>) => `---\nid: ${BR(1)}\ntitle: 规则\nstatus: active\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n## 规则\n\n规则的行为。\n\n## 例子\n\n- 输入 → 结果\n`;
    const records = (hash: string) => `---\nid: ${id("C", 1)}\ntitle: 做了\nstatus: done\nrules: [${BR(1)}]\npasses:\n  ${BR(1)}: "${hash} acceptance"\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n## 任务\n\n- [x] x\n`;
    const root = fixture({ [rulePath(1)]: rule({ untested: "fixture" }), [releasePath(1)]: releaseFile(1, { status: "active" }), [releasePath(2)]: releaseFile(2, { status: "active" }), [releasePath(3)]: releaseFile(3, { status: "active" }) });
    const first = canon(root, "progress", "billing");
    expect(first.out).toContain(`待重新执行: ${BR(1)}`);
    const body = readFileSync(join(root, rulePath(1)), "utf8").split("---\n").slice(2).join("---\n");
    write(root, { [`canon/changes/${id("C", 1)}.md`]: records(behaviourHash(body)) });
    commit(root);
    expect(canon(root, "progress", "billing").out).toContain(`已通过: ${BR(1)} (${id("C", 1)})`);
    write(root, { [rulePath(1)]: rule({ untested: "fixture", release: R(1) }) });
    commit(root);
    expect(canon(root, "progress", "billing").out).toContain(`已通过: ${BR(1)}`);
    write(root, { [rulePath(1)]: rule({ untested: "fixture", release: R(2), changed_in: `[${R(3)}]` }) });
    commit(root);
    expect(canon(root, "progress", "billing").out).toContain(`已通过: ${BR(1)}`);
    write(root, { [rulePath(1)]: rule({ untested: "fixture", release: R(2) }).replace("规则的行为。", "规则的行为，多了一个条件。") });
    commit(root);
    expect(canon(root, "progress", "billing").out).toContain(`待重新执行: ${BR(1)}`);
  });
});

describe("a shipped release stays what it was", () => {
  /** R-1 shipped at the commit that held it active, with BR-1 tagged R-1 then; returns the root, the shipped commit and the helper to re-ship. */
  function shipped(extra: Record<string, string> = {}) {
    const root = fixture({
      [releasePath(1)]: releaseFile(1, { status: "active" }, { 范围: "登录", 不做: "支付" }),
      [rulePath(3)]: ruleFile(3, { release: R(1) }),
      [rulePath(4)]: ruleFile(4),
      ...extra,
    });
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [releasePath(1)]: releaseFile(1, { status: "shipped", shipped_at: sha }, { 范围: "登录", 不做: "支付" }) });
    commit(root, "ship");
    return { root, sha };
  }
  const frozen = (root: string) => findings(root).filter((f) => f.rule === "release-frozen");

  test("BR-2325: the three frozen sections must read as they did at shipped_at; other sections may change", () => {
    const { root, sha } = shipped();
    expect(findings(root)).toEqual([]);
    const reship = (extra: Partial<Record<string, string>>) => write(root, { [releasePath(1)]: releaseFile(1, { status: "shipped", shipped_at: sha }, { 范围: "登录", 不做: "支付", ...extra }) });
    reship({ 范围: "登录、注册" });
    expect(frozen(root).map((f) => f.message)).toEqual([expect.stringContaining("## 范围")]);
    reship({ 不做: "  支付  \n\n" });
    expect(frozen(root)).toEqual([]);
    reship({ 成功标准: "改了" });
    expect(frozen(root)).toEqual([]);
    reship({ 目标: "改了", 不做: "改了" });
    expect(frozen(root).map((f) => f.message.match(/## (\S+) changed/)![1]).sort()).toEqual(["不做", "目标"]);
  });

  test("BR-2325: a shipped_at the repository does not know is release-frozen, and an active release is free to change", () => {
    const { root } = shipped();
    write(root, { [releasePath(1)]: releaseFile(1, { status: "shipped", shipped_at: "c".repeat(40) }, { 范围: "登录", 不做: "支付" }) });
    expect(frozen(root).map((f) => f.path)).toEqual([releasePath(1)]);
    const free = fixture({ [releasePath(1)]: releaseFile(1, { status: "active" }, { 范围: "登录" }), [rulePath(1)]: ruleFile(1, { release: R(1) }) });
    write(free, { [releasePath(1)]: releaseFile(1, { status: "active" }, { 范围: "完全不同" }) });
    expect(frozen(free)).toEqual([]);
  });

  test("BR-2326: the rules tagged with a shipped release are the ones tagged at shipped_at; retiring one or adding changed_in is fine", () => {
    const { root } = shipped();
    expect(frozen(root)).toEqual([]);
    write(root, { [rulePath(3)]: ruleFile(3, { release: R(1), changed_in: `[${R(2)}]` }) });
    write(root, { [releasePath(2)]: releaseFile(2, { status: "planned" }) });
    expect(frozen(root)).toEqual([]);
    write(root, { [rulePath(3)]: ruleFile(3, { release: R(1) }, "retired") });
    expect(frozen(root)).toEqual([]);
    // moved to another release, or the tag deleted
    write(root, { [rulePath(3)]: ruleFile(3, { release: R(2) }) });
    expect(frozen(root).map((f) => [f.path, f.message.includes(BR(3))])).toEqual([[rulePath(3), true]]);
    write(root, { [rulePath(3)]: ruleFile(3) });
    expect(frozen(root).map((f) => f.path)).toEqual([rulePath(3)]);
    // a rule added after the ship, and an old rule tagged late
    write(root, { [rulePath(3)]: ruleFile(3, { release: R(1) }), [rulePath(9)]: ruleFile(9, { release: R(1) }) });
    expect(frozen(root).map((f) => f.path)).toEqual([rulePath(9)]);
    write(root, { [rulePath(9)]: ruleFile(9), [rulePath(4)]: ruleFile(4, { release: R(1) }) });
    expect(frozen(root).map((f) => f.path)).toEqual([rulePath(4)]);
  });

  test("BR-2326: a release still being built moves its rules freely", () => {
    const root = fixture({ [releasePath(1)]: releaseFile(1, { status: "active" }), [releasePath(2)]: releaseFile(2, { status: "planned" }), [rulePath(3)]: ruleFile(3, { release: R(1) }, "planned") });
    write(root, { [rulePath(3)]: ruleFile(3, { release: R(2) }, "planned") });
    expect(findings(root)).toEqual([]);
  });
});
