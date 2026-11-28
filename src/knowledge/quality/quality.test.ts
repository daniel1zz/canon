import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default (as in features.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const Q = (n: number) => id("Q", n);
const BR = (n: number) => id("BR", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function write(root: string, files: Record<string, string>, commit = true) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  if (!commit) return;
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
}

const standard = (n: number, front: string, body = "## 门槛\n\n首领场地在 960×540 下约 640×400。\n\n## 来源\n\n- 暖雪实测\n") => `---\nid: ${Q(n)}\ntitle: 标准${n}\n${front}---\n\n${body}`;
const front = (aspect: string, extra = "", covers = "[.]", judge = "owner") => `aspect: ${aspect}\njudge: ${judge}\ncovers: ${covers}\n${extra}`;
const aspects = (...items: string[]) => `# 质量标准\n\n说明文字。\n\n## 方面\n\n${items.join("\n")}\n`;
const README = "canon/quality/README.md";
const findings = (root: string) => JSON.parse(canon(root, "check", "--json").out) as { rule: string; path: string; message: string }[];
const about = (root: string, path: string) => findings(root).filter((f) => f.path.startsWith(path));

describe("quality standards", () => {
  test("BR-2552: a quality standard reads its aspect, judge, covers and retired_reason; bad values are file-invalid, missing sections doc-missing-section; show and ids work", () => {
    const root = project();
    write(root, {
      [README]: aspects("- **战斗手感**："),
      [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感")),
    });
    expect(about(root, "canon/quality")).toEqual([]);
    const shown = canon(root, "show", Q(1));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("首领场地");
    expect(canon(root, "search", "首领场地").out).toContain(Q(1));
    const bad: Record<string, string> = {
      judge: front("战斗手感", "", "[.]", "player"),
      covers: "aspect: 战斗手感\njudge: owner\ncovers: []\n",
      "covers ": front("战斗手感", "", "[/etc]"),
      "covers  ": front("战斗手感", "", "[../other]"),
      retired_reason: front("战斗手感", "status: retired\n"),
      "retired_reason ": front("战斗手感", "status: active\nretired_reason: 不用了\n"),
      status: front("战斗手感", "status: done\n"),
    };
    let n = 10;
    for (const [field, fm] of Object.entries(bad)) {
      const r = project();
      write(r, { [README]: aspects("- **战斗手感**："), [`canon/quality/${Q(n)}.md`]: standard(n, fm) });
      const got = about(r, `canon/quality/${Q(n)}.md`);
      expect(got.map((f) => f.rule)).toEqual(["file-invalid"]);
      if (field.trim() !== "status") expect(got[0]!.message).toContain(field.trim());
      n++;
    }
    const retired = project();
    write(retired, { [README]: aspects("- **战斗手感**："), [`canon/quality/${Q(2)}.md`]: standard(2, front("战斗手感", "status: retired\nretired_reason: 改成回合制，不再有实时战斗\n")) });
    expect(about(retired, "canon/quality")).toEqual([]);
    const noSources = project();
    write(noSources, { [README]: aspects("- **战斗手感**："), [`canon/quality/${Q(3)}.md`]: standard(3, front("战斗手感"), "## 门槛\n\n一句话。\n") });
    expect(about(noSources, `canon/quality/${Q(3)}.md`).map((f) => f.rule)).toEqual(["doc-missing-section"]);
    const dangling = project();
    write(dangling, { "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n", "src/billing/.keep": "", [`canon/rules/billing/${BR(1)}.md`]: `---\nid: ${BR(1)}\ntitle: 规则\nstatus: active\nuntested: fixture\n---\n## 规则\n\n要满足 ${Q(9)}。\n\n## 例子\n\n- a → b\n` });
    expect(findings(dangling).some((f) => f.rule === "ref-dangling" && f.message.includes(Q(9)))).toBe(true);
  });

  test("BR-2553: quality new writes a draft with aspect, judge and covers and the two sections; missing or bad arguments write nothing (exit 2); an unlisted aspect is said, not refused", () => {
    const root = project();
    const wt = startNew(root, "质量标准").worktree;
    const made = canon(wt, "quality", "new", "--title", "首领场地约 640×400", "--aspect", "关卡空间", "--judge", "agent", "--covers", "src/levels, src/boss");
    expect(made.code).toBe(0);
    const text = readFileSync(join(wt, made.out.trim()), "utf8");
    expect(made.out.trim()).toMatch(/^canon\/quality\/Q-\d+\.md$/);
    expect(text).toContain("status: draft");
    expect(text).toContain("aspect: 关卡空间");
    expect(text).toContain("judge: agent");
    expect(text).toMatch(/covers:\n {2}- src\/levels\n {2}- src\/boss/);
    expect(text).toContain("## 门槛");
    expect(text).toContain("## 来源");
    expect(made.err).toContain("关卡空间");
    expect(made.err).toContain(README);
    const count = () => (existsSync(join(wt, "canon/quality")) ? readdirSync(join(wt, "canon/quality")).length : 0);
    const before = count();
    for (const args of [
      ["--aspect", "关卡空间", "--judge", "player", "--covers", "."],
      ["--aspect", "关卡空间", "--judge", "owner"],
      ["--aspect", "关卡空间", "--judge", "owner", "--covers", " , "],
      ["--judge", "owner", "--covers", "."],
    ]) {
      expect(canon(wt, "quality", "new", "--title", "x", ...args).code).toBe(2);
    }
    expect(count()).toBe(before);
    write(wt, { [README]: aspects("- **关卡空间**：") }, false);
    expect(canon(wt, "quality", "new", "--title", "y", "--aspect", "关卡空间", "--judge", "test", "--covers", ".").err).not.toContain("not listed");
  });

  test("BR-2554: quality list shows standards in force by number, drafts marked as not confirmed by the owner; retired only with --all; --json has confirmed", () => {
    const root = project();
    expect(canon(root, "quality", "list").out.trim()).toBe("(no quality standards)");
    write(root, {
      [`canon/quality/${Q(10)}.md`]: standard(10, front("音效", "status: active\n")),
      [`canon/quality/${Q(9)}.md`]: standard(9, front("战斗手感")),
      [`canon/quality/${Q(3)}.md`]: standard(3, front("联机", "status: retired\nretired_reason: 不做联机\n")),
    });
    const lines = canon(root, "quality", "list").out.trim().split("\n").map((l) => l.replace(/\s+/g, " "));
    expect(lines).toEqual([`${Q(9)} draft 标准9 方面 战斗手感 判定 owner (负责人未确认) 判定状态 没判过`, `${Q(10)} active 标准10 方面 音效 判定 owner 判定状态 没判过`]);
    expect(canon(root, "quality", "list", "--all").out).toContain(Q(3));
    const json = JSON.parse(canon(root, "quality", "list", "--json").out);
    expect(json[0]).toEqual({ id: Q(9), status: "draft", title: "标准9", aspect: "战斗手感", judge: "owner", covers: ["."], confirmed: false, verdict: null });
    expect(json[1].confirmed).toBe(true);
  });

  test("BR-2555: canon check: an aspect not in the list and a covered entry that exists nowhere are ref-dangling; an aspect set aside by the owner with standards is quality-aspect; retired ones are not checked", () => {
    const root = project();
    write(root, {
      "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n",
      "src/billing/.keep": "",
      [README]: aspects("- **战斗手感**：", "- **音效**：推迟：「先不做音效」"),
      [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感", "", "[billing, src/billing, .]")),
      [`canon/quality/${Q(2)}.md`]: standard(2, front("剧情")),
      [`canon/quality/${Q(3)}.md`]: standard(3, front("战斗手感", "", "[src/combat]")),
      [`canon/quality/${Q(4)}.md`]: standard(4, front("音效", "status: active\n")),
      [`canon/quality/${Q(5)}.md`]: standard(5, front("剧本", "status: retired\nretired_reason: 不要了\n", "[src/nowhere]")),
    });
    const got = about(root, "canon/quality");
    expect(got.filter((f) => f.path.endsWith(`${Q(1)}.md`))).toEqual([]);
    const two = got.filter((f) => f.path.endsWith(`${Q(2)}.md`));
    expect(two.map((f) => f.rule)).toEqual(["ref-dangling"]);
    expect(two[0]!.message).toContain("剧情");
    expect(two[0]!.message).toContain(README);
    const three = got.filter((f) => f.path.endsWith(`${Q(3)}.md`));
    expect(three.map((f) => f.rule)).toEqual(["ref-dangling"]);
    expect(three[0]!.message).toContain("src/combat");
    const aside = got.filter((f) => f.rule === "quality-aspect");
    expect(aside).toHaveLength(1);
    expect(aside[0]!.message).toContain("音效");
    expect(aside[0]!.message).toContain(Q(4));
    expect(got.some((f) => f.path.endsWith(`${Q(5)}.md`))).toBe(false);
    const noList = project();
    write(noList, { [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感")) });
    expect(about(noList, `canon/quality/${Q(1)}.md`).map((f) => f.rule)).toEqual(["ref-dangling"]);
  });

  test("BR-2556: the aspect list: names, the owner's decisions with words or a question number; a malformed item, a duplicate, a decision without the owner's words or no 方面 section are file-invalid with the line", () => {
    const root = project();
    write(root, {
      [README]: `${aspects("- **战斗手感**：打击要有停顿", "- **音效**：推迟：负责人 2026-11-20「demo 之后再定音效」", "- **联机**：不适用：canon human #12", "- **界面**：不适用的地方很少", "  - 续行不读")}\n\`\`\`\n- **示例**\n\`\`\`\n`,
    });
    expect(about(root, README)).toEqual([]);
    const status = canon(root, "quality", "status").out.split("\n");
    expect(status.slice(0, 4)).toEqual(["战斗手感  未覆盖", "音效  推迟：负责人 2026-11-20「demo 之后再定音效」", "联机  不适用：canon human #12", "界面  未覆盖"]);
    expect(status.join("\n")).not.toContain("示例");
    for (const [line, why] of [
      ["- **剧情**：不适用：没有剧情", "owner's words"],
      ["- **剧情**：不适用：「」", "owner's words"],
      ["- 剧情", "**<aspect>**"],
    ] as const) {
      const r = project();
      write(r, { [README]: aspects("- **战斗手感**：", line) });
      const got = about(r, README);
      expect(got.map((f) => f.rule)).toEqual(["file-invalid"]);
      expect(got[0]!.path).toBe(`${README}:8`);
      expect(got[0]!.message).toContain(why);
    }
    const twice = project();
    write(twice, { [README]: aspects("- **音效**", "- **音效**：再写一次") });
    expect(about(twice, README).map((f) => f.message).join()).toContain("twice");
    const noSection = project();
    write(noSection, { [README]: "# 质量标准\n" });
    expect(about(noSection, README).map((f) => f.rule)).toEqual(["file-invalid"]);
  });

  test("BR-2557: quality status lists each aspect's standards in force, the owner's decision or 未覆盖, the standards outside the list, and the overview's line; --json the same", () => {
    const root = project();
    expect(canon(root, "quality", "status").out.split("\n")[0]).toBe(`(no aspects: ${README} lists none)`);
    write(root, {
      [README]: aspects("- **战斗手感**：", "- **音效**：推迟：「demo 之后」", "- **联机**："),
      [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感", "status: active\n")),
      [`canon/quality/${Q(2)}.md`]: standard(2, front("战斗手感")),
      [`canon/quality/${Q(3)}.md`]: standard(3, front("联机", "status: retired\nretired_reason: 不做了\n")),
      [`canon/quality/${Q(4)}.md`]: standard(4, front("性能")),
    });
    const r = canon(root, "quality", "status");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      `战斗手感  ${Q(1)} active 判定状态 没判过, ${Q(2)} draft(负责人未确认) 判定状态 没判过`,
      "音效  推迟：「demo 之后」",
      "联机  未覆盖",
      `不在方面清单里：${Q(4)} (性能)`,
      "质量标准 3 条，其中 draft 2 条（负责人未确认）；未覆盖的方面：联机（canon quality status；用 canon-product 补上）",
    ]);
    const json = JSON.parse(canon(root, "quality", "status", "--json").out);
    expect(json.aspects[2]).toEqual({ name: "联机", state: "uncovered", reason: null, standards: [] });
    expect(json.aspects[1]).toMatchObject({ name: "音效", state: "deferred", reason: "「demo 之后」" });
    expect(json.aspects[0].standards).toEqual([{ id: Q(1), status: "active", verdict: null }, { id: Q(2), status: "draft", verdict: null }]);
    expect(json.unlisted).toEqual([Q(4)]);
  });

  test("BR-2558: the overview always has a quality line; the brief's summary has one only when nothing is set or an aspect is uncovered, naming at most 5", () => {
    const root = project();
    const briefLine = (r: string) => canon(r, "brief").out.split("\n").find((l) => l.startsWith("  quality:"));
    expect(canon(root, "overview").out).toContain("质量标准：还没有（canon/quality）。用 canon-product 按产品类型调研同类产品，列出方面、写 Q-n");
    expect(briefLine(root)).toBe("  quality: no quality standards yet (canon/quality): research them with the canon-product skill, then canon quality new --title \"<standard>\"");
    expect(JSON.parse(canon(root, "overview", "--json").out).quality).toEqual({ standards: 0, drafts: 0, uncovered: [], none: true });
    write(root, { [README]: aspects("- **战斗手感**：", "- **音效**："), [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感")) });
    expect(canon(root, "overview").out).toContain("质量标准 1 条，其中 draft 1 条（负责人未确认）；未覆盖的方面：音效（canon quality status；用 canon-product 补上）");
    expect(briefLine(root)).toBe("  quality: aspects not covered: 音效 (canon quality status; canon-product skill)");
    write(root, { [README]: aspects("- **战斗手感**：", "- **音效**：推迟：「demo 之后再定」") });
    expect(canon(root, "overview").out).toContain("质量标准 1 条，其中 draft 1 条（负责人未确认）；方面都有着落");
    expect(briefLine(root)).toBeUndefined();
    const decided = project();
    write(decided, { [README]: aspects("- **联机**：不适用：canon human #3") });
    expect(canon(decided, "overview").out).toContain("方面都有着落");
    const seven = project();
    write(seven, { [README]: aspects(...["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((a) => `- **${a}**：`)) });
    expect(briefLine(seven)).toBe("  quality: aspects not covered: 甲, 乙, 丙, 丁, 戊, and 2 more (canon quality status; canon-product skill)");
    const retiredOnly = project();
    write(retiredOnly, { [`canon/quality/${Q(1)}.md`]: standard(1, front("战斗手感", "status: retired\nretired_reason: 不要了\n")) });
    expect(briefLine(retiredOnly)).toBe("  quality: no quality standards yet (canon/quality): research them with the canon-product skill, then canon quality new --title \"<standard>\"");
  });
});
