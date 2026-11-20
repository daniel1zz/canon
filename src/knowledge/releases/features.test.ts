import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, sh, startNew } from "../../work/testkit.ts";

// reason: each case spawns canon several times; a loaded machine takes longer than bun's 5 s default (as in status.test.ts)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const id = (p: string, n: number) => [p, n].join("-");
const R = (n: number) => id("R", n);
const F = (n: number) => id("F", n);
const BR = (n: number) => id("BR", n);
const C = (n: number) => id("C", n);

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:a", CANON_MACHINE_DIR: mkdtempSync(join(tmpdir(), "canon-machine-")) } });
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

const RELEASE_SECTIONS = ["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"];
const release = (n: number, front = "status: planned\n") => `---\nid: ${R(n)}\ntitle: 版本${n}\n${front}---\n\n${RELEASE_SECTIONS.map((s) => `## ${s}\n\n内容\n`).join("\n")}`;
const feature = (n: number, status = "active") => `---\nid: ${F(n)}\ntitle: 模块${n}\nstatus: ${status}\n---\n\n${["目标", "范围", "不做", "成功标准"].map((s) => `## ${s}\n\n内容\n`).join("\n")}`;
const rule = (n: number, front: string, status = "active") => `---\nid: ${BR(n)}\ntitle: 规则${n}\nstatus: ${status}\nuntested: fixture\n${front}---\n## 规则\n\n规则${n}的行为。\n\n## 例子\n\n- 输入 → 结果\n`;
const DOMAIN = { "canon/rules/billing/README.md": "---\ncode: [src/billing]\n---\n# billing\n", "src/billing/.keep": "" };
const findings = (root: string) => JSON.parse(canon(root, "check", "--json").out) as { rule: string; path: string; message: string }[];

/** A change worktree to run the writing commands in: main's checkout refuses them (BR-2508). */
const worktree = (root: string) => startNew(root, "版本调整").worktree;

describe("features", () => {
  test("BR-2507: feature new writes an active feature with four sections; list shows the releases listing it, (no release), dropped only with --all", () => {
    const root = project();
    const wt = worktree(root);
    const made = canon(wt, "feature", "new", "--title", "基因体系");
    expect(made.code).toBe(0);
    const text = readFileSync(join(wt, made.out.trim()), "utf8");
    expect(text).toContain("status: active");
    for (const s of ["目标", "范围", "不做", "成功标准"]) expect(text).toContain(`## ${s}`);
    const root2 = project();
    expect(canon(root2, "feature", "list").out.trim()).toBe("(no features)");
    write(root2, { [`canon/features/${F(1)}.md`]: feature(1), [`canon/features/${F(2)}.md`]: feature(2), [`canon/features/${F(3)}.md`]: feature(3, "dropped"), [`canon/releases/${R(5)}.md`]: release(5, `status: active\nfeatures: [${F(1)}]\n`) });
    const lines = canon(root2, "feature", "list").out.trim().split("\n").map((l) => l.replace(/\s+/g, " "));
    expect(lines).toEqual([`${F(1)} active 模块1 ${R(5)}`, `${F(2)} active 模块2 (no release)`]);
    expect(canon(root2, "feature", "list", "--all").out).toContain(F(3));
    expect(JSON.parse(canon(root2, "feature", "list", "--json").out)[0]).toEqual({ id: F(1), status: "active", title: "模块1", releases: [R(5)] });
    write(root2, { [`canon/features/${F(4)}.md`]: feature(4, "done") });
    expect(findings(root2).some((f) => f.rule === "file-invalid" && f.path.endsWith(`${F(4)}.md`))).toBe(true);
  });

  test("BR-2509: a rule attached to a feature belongs to every release listing it; release and feature together, or a bad feature id, are invalid", () => {
    const root = project();
    write(root, {
      ...DOMAIN,
      [`canon/features/${F(1)}.md`]: feature(1),
      [`canon/releases/${R(5)}.md`]: release(5, `status: active\nfeatures: [${F(1)}]\n`),
      [`canon/rules/billing/${BR(7)}.md`]: rule(7, `feature: ${F(1)}\n`, "planned"),
    });
    expect(canon(root, "release", "status").out.replace(/\s+/g, " ")).toContain(`${R(5)} active 版本5 规划中 1`);
    expect(canon(root, "show", BR(7)).out.split("\n")[0]).toContain(`[feature ${F(1)}]`);
    write(root, { [`canon/rules/billing/${BR(8)}.md`]: rule(8, `release: ${R(5)}\nfeature: ${F(1)}\n`), [`canon/rules/billing/${BR(9)}.md`]: rule(9, `feature: ${F(99)}\n`), [`canon/rules/billing/${BR(10)}.md`]: rule(10, `feature: ${R(5)}\n`) });
    const got = findings(root);
    expect(got.some((f) => f.rule === "file-invalid" && f.path.endsWith(`${BR(8)}.md`))).toBe(true);
    expect(got.some((f) => f.rule === "ref-dangling" && f.message.includes(F(99)))).toBe(true);
    expect(got.some((f) => f.rule === "file-invalid" && f.path.endsWith(`${BR(10)}.md`))).toBe(true);
  });

  test("BR-2513: feature drop marks it dropped once, refuses one a shipped release lists, and a non-feature is not found", () => {
    const root = project();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/features/${F(1)}.md`]: feature(1), [`canon/features/${F(2)}.md`]: feature(2), [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\nfeatures: [${F(1)}]\n`) });
    const wt = worktree(root);
    const r = canon(wt, "feature", "drop", F(2));
    expect([r.code, r.out.trim()]).toEqual([0, `${F(2)} → dropped (canon/features/${F(2)}.md; commit it with your change)`]);
    expect(readFileSync(join(wt, `canon/features/${F(2)}.md`), "utf8")).toContain("status: dropped");
    expect(canon(wt, "feature", "drop", F(2)).out.trim()).toBe(`${F(2)} is already dropped`);
    expect(canon(wt, "feature", "drop", F(1)).code).toBe(1);
    expect(canon(wt, "feature", "drop", R(1)).code).toBe(3);
  });
});

describe("release start and drop", () => {
  test("BR-2508: start marks a planned release active once; shipped or dropped is refused; a non-release is not found", () => {
    const root = project();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\n`), [`canon/releases/${R(3)}.md`]: release(3, "status: dropped\n"), [`canon/releases/${R(5)}.md`]: release(5) });
    const wt = worktree(root);
    const r = canon(wt, "release", "start", R(5));
    expect([r.code, r.out.trim()]).toEqual([0, `${R(5)} → active (canon/releases/${R(5)}.md; commit it with your change)`]);
    expect(readFileSync(join(wt, `canon/releases/${R(5)}.md`), "utf8")).toContain("status: active");
    expect(canon(wt, "release", "start", R(5)).out.trim()).toBe(`${R(5)} is already active`);
    expect(canon(wt, "release", "start", R(1)).code).toBe(1);
    expect(canon(wt, "release", "start", R(3)).code).toBe(1);
    expect(canon(wt, "release", "start", R(99)).code).toBe(3);
    expect(canon(wt, "release", "start", C(3)).code).toBe(3);
  });

  test("BR-2511 BR-2521: drop writes dropped and merged_into; --into itself, a shipped or missing release is refused; a shipped release is not dropped", () => {
    const root = project();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\n`), [`canon/releases/${R(3)}.md`]: release(3), [`canon/releases/${R(4)}.md`]: release(4, "status: active\n"), ...DOMAIN, [`canon/rules/billing/${BR(7)}.md`]: rule(7, `release: ${R(3)}\n`, "planned") });
    const wt = worktree(root);
    for (const into of [R(3), R(1), R(9)]) expect(canon(wt, "release", "drop", R(3), "--into", into).code).toBe(1);
    expect(readFileSync(join(wt, `canon/releases/${R(3)}.md`), "utf8")).toContain("status: planned");
    const r = canon(wt, "release", "drop", R(3), "--into", R(4));
    expect(r.code).toBe(0);
    const text = readFileSync(join(wt, `canon/releases/${R(3)}.md`), "utf8");
    expect([text.includes("status: dropped"), text.includes(`merged_into: ${R(4)}`)]).toEqual([true, true]);
    // The dropped release's rule now counts in the release it went into, untouched (BR-2511, BR-2521).
    expect((JSON.parse(canon(wt, "release", "status", R(4), "--json").out) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual([BR(7)]);
    expect(canon(wt, "release", "drop", R(3)).out.trim()).toBe(`${R(3)} is already dropped`);
    expect(canon(wt, "release", "drop", R(1)).code).toBe(1);
  });

  test("BR-2320 BR-2321: list leaves dropped releases out unless --all; dropped may carry merged_into, other statuses may not", () => {
    const root = project();
    write(root, { [`canon/releases/${R(2)}.md`]: release(2), [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(2)}\n`) });
    expect(canon(root, "release", "list").out).not.toContain(R(3));
    expect(canon(root, "release", "list", "--all").out).toContain(R(3));
    expect(findings(root)).toEqual([]);
    write(root, { [`canon/releases/${R(2)}.md`]: release(2, `status: active\nmerged_into: ${R(3)}\n`) });
    expect(findings(root).some((f) => f.rule === "file-invalid" && f.path.endsWith(`${R(2)}.md`))).toBe(true);
  });
});

describe("what a release is made of", () => {
  test("BR-2512: missing, dropped or doubly listed features, and rules naming a dropped release or feature, are findings", () => {
    const root = project();
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, {
      ...DOMAIN,
      [`canon/features/${F(1)}.md`]: feature(1),
      [`canon/features/${F(2)}.md`]: feature(2, "dropped"),
      [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\nfeatures: [${F(1)}]\n`),
      [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(4)}\nfeatures: [${F(2)}]\n`),
      [`canon/releases/${R(4)}.md`]: release(4, `status: active\nfeatures: [${F(1)}, ${F(9)}]\n`),
      [`canon/releases/${R(5)}.md`]: release(5, `status: planned\nfeatures: [${F(1)}, ${F(2)}]\n`),
      [`canon/rules/billing/${BR(7)}.md`]: rule(7, `release: ${R(3)}\n`),
      [`canon/rules/billing/${BR(8)}.md`]: rule(8, `feature: ${F(2)}\n`),
      [`canon/rules/billing/${BR(9)}.md`]: rule(9, `feature: ${F(2)}\n`, "retired"),
    });
    const got = findings(root).filter((f) => f.rule !== "release-frozen");
    const has = (rule: string, path: string, text: string) => got.some((f) => f.rule === rule && f.path.endsWith(path) && f.message.includes(text));
    expect(has("ref-dangling", `${R(4)}.md`, F(9))).toBe(true);
    expect(has("release-composition", `${R(4)}.md`, R(5))).toBe(true);
    expect(has("release-composition", `${R(5)}.md`, R(4))).toBe(true);
    expect(has("release-composition", `${R(5)}.md`, F(2))).toBe(true);
    // reason: R-3 went into R-4, so BR-7 counts as R-4's and is not stranded (BR-2521)
    expect(got.some((f) => f.path.endsWith(`${BR(7)}.md`))).toBe(false);
    expect(has("release-dropped", `${BR(8)}.md`, F(2))).toBe(true);
    expect(got.some((f) => f.path.endsWith(`${BR(9)}.md`))).toBe(false);
    expect(got.some((f) => f.path.endsWith(`${R(1)}.md`) || f.path.endsWith(`${R(3)}.md`))).toBe(false);
  });

  test("BR-2512: an open change, with a plan or without, linked to a release dropped with nowhere to go or to a dropped feature is a hint, not a finding", () => {
    const root = project();
    const change = (n: number, status: string, front: string, body = "") => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\n${front}---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n\n${body}`;
    const plan = "## 计划\n\n| 步骤 | 内容 | 依赖 |\n|---|---|---|\n| 1 | 建表 | - |\n";
    write(root, {
      ...DOMAIN,
      [`canon/features/${F(2)}.md`]: feature(2, "dropped"),
      [`canon/releases/${R(3)}.md`]: release(3, "status: dropped\n"),
      [`canon/releases/${R(4)}.md`]: release(4, "status: active\n"),
      [`canon/changes/${C(4)}.md`]: change(4, "open", `release: ${R(3)}\n`, plan),
      [`canon/changes/${C(5)}.md`]: change(5, "open", `feature: ${F(2)}\n`),
      [`canon/changes/${C(6)}.md`]: change(6, "done", `release: ${R(3)}\n`),
      [`canon/changes/${C(7)}.md`]: change(7, "open", `release: ${R(4)}\n`),
    });
    expect(findings(root).filter((f) => f.path.includes("canon/changes/"))).toEqual([]);
    const r = canon(root, "check");
    expect(r.err).toContain(`hint change-link-dropped: ${C(4)} is linked to ${R(3)}, which is dropped`);
    expect(r.err).toContain(`hint change-link-dropped: ${C(5)} is linked to ${F(2)}, which is dropped`);
    expect(r.err).not.toContain(`${C(6)} is linked`);
    expect(r.err).not.toContain(`${C(7)} is linked`);
    write(root, { [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(4)}\n`) });
    expect(canon(root, "check").err).not.toContain(`${C(4)} is linked`);
  });

  test("BR-2514: a planned release with passed rules, directly or through a feature, gets a hint on stderr; active gets none", () => {
    const root = project();
    write(root, {
      ...DOMAIN,
      [`canon/features/${F(1)}.md`]: feature(1),
      [`canon/releases/${R(2)}.md`]: release(2, `status: planned\nfeatures: [${F(1)}]\n`),
      [`canon/rules/billing/${BR(7)}.md`]: rule(7, `feature: ${F(1)}\n`),
      [`canon/rules/billing/${BR(8)}.md`]: rule(8, `release: ${R(2)}\n`),
      [`canon/changes/${C(4)}.md`]: `---\nid: ${C(4)}\ntitle: 做了\nstatus: done\nrules: [${BR(7)}, ${BR(8)}]\npasses:\n  ${BR(7)}: "0000000000000000 acceptance"\n  ${BR(8)}: "0000000000000000 acceptance"\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`,
    });
    const r = canon(root, "check");
    expect(r.err).toContain(`hint release-planned: ${R(2)} is planned, but 2 rule(s) tagged with it have pass records: mark the release in progress with canon release start ${R(2)}`);
    write(root, { [`canon/releases/${R(2)}.md`]: release(2, `status: active\nfeatures: [${F(1)}]\n`) });
    expect(canon(root, "check").err).not.toContain("hint release-planned");
  });

  test("BR-2515: a shipped release keeps its features and their rules; a later feature list, a dropped feature, a moved or newly attached rule are frozen", () => {
    const root = project();
    write(root, { ...DOMAIN, [`canon/features/${F(1)}.md`]: feature(1), [`canon/features/${F(2)}.md`]: feature(2), [`canon/rules/billing/${BR(3)}.md`]: rule(3, `feature: ${F(1)}\n`), [`canon/releases/${R(1)}.md`]: release(1, `status: planned\nfeatures: [${F(1)}]\n`) });
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\nfeatures: [${F(1)}]\n`) });
    expect(findings(root).filter((f) => f.rule === "release-frozen")).toEqual([]);
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\nfeatures: [${F(1)}, ${F(2)}]\n`) });
    expect(findings(root).some((f) => f.rule === "release-frozen" && f.path.endsWith(`${R(1)}.md`))).toBe(true);
    write(root, { [`canon/releases/${R(1)}.md`]: release(1, `status: shipped\nshipped_at: ${sha}\nfeatures: [${F(1)}]\n`), [`canon/features/${F(1)}.md`]: feature(1, "dropped") });
    expect(findings(root).some((f) => f.rule === "release-frozen" && f.path.endsWith(`${F(1)}.md`))).toBe(true);
    write(root, { [`canon/features/${F(1)}.md`]: feature(1), [`canon/rules/billing/${BR(3)}.md`]: rule(3, `feature: ${F(2)}\n`), [`canon/rules/billing/${BR(9)}.md`]: rule(9, `feature: ${F(1)}\n`) });
    const frozen = findings(root).filter((f) => f.rule === "release-frozen");
    expect([frozen.some((f) => f.path.endsWith(`${BR(3)}.md`)), frozen.some((f) => f.path.endsWith(`${BR(9)}.md`))]).toEqual([true, true]);
    write(root, { [`canon/rules/billing/${BR(3)}.md`]: rule(3, `feature: ${F(1)}\n`, "retired"), [`canon/rules/billing/${BR(9)}.md`]: rule(9, "") });
    expect(findings(root).filter((f) => f.rule === "release-frozen")).toEqual([]);
    expect(existsSync(join(root, "canon"))).toBe(true);
  });
});

describe("criterion ids and advances", () => {
  const withCriteria = (n: number, criteria: string, front = "status: active\n") => release(n, front).replace("## 成功标准\n\n内容\n", `## 成功标准\n\n${criteria}\n`);
  const featureWith = (n: number, criteria: string) => feature(n).replace("## 成功标准\n\n内容\n", `## 成功标准\n\n${criteria}\n`);
  const change = (n: number, status: string, advances: string) => `---\nid: ${C(n)}\ntitle: 变更${n}\nstatus: ${status}\nrules: []\nadvances: ${advances}\n---\n\n## 为什么\n\nx\n\n## 要改什么\n\nx\n`;

  test("BR-2516: an id twice in one document is file-invalid; the same id in two documents, or criteria without ids, are not", () => {
    const root = project();
    write(root, { [`canon/releases/${R(5)}.md`]: withCriteria(5, "- S1 甲\n- S2 乙\n- S1 丙\n- 丁\n- 戊"), [`canon/features/${F(1)}.md`]: featureWith(1, "- S1 甲") });
    const got = findings(root).filter((f) => f.rule === "file-invalid");
    expect(got.map((f) => [f.path.split("/").pop(), f.message.includes("S1")])).toEqual([[`${R(5)}.md`, true]]);
  });

  test("BR-2517: advances must be a list of <doc>/S<n> or none with a reason; an open change naming a missing criterion is dangling, a done one is history", () => {
    const root = project();
    write(root, { [`canon/releases/${R(5)}.md`]: withCriteria(5, "- S1 甲\n- S3 丙"), [`canon/features/${F(2)}.md`]: featureWith(2, "- S1 乙") });
    write(root, {
      [`canon/changes/${C(4)}.md`]: change(4, "open", `[${R(5)}/S3, ${F(2)}/S1]`),
      [`canon/changes/${C(5)}.md`]: change(5, "open", '"none: 修 YAML 转义"'),
      [`canon/changes/${C(6)}.md`]: change(6, "open", `[${R(5)}/S9]`),
      [`canon/changes/${C(7)}.md`]: change(7, "done", `[${R(5)}/S9]`),
      [`canon/changes/${C(8)}.md`]: change(8, "open", `[${R(9)}/S1]`),
    });
    const got = findings(root);
    const on = (n: number) => got.filter((f) => f.path.endsWith(`${C(n)}.md`)).map((f) => f.rule);
    expect([on(4), on(5), on(6), on(7), on(8)]).toEqual([[], [], ["ref-dangling"], [], ["ref-dangling"]]);
    for (const bad of ['"none:"', "[]", `[${R(5)}-S3]`]) {
      write(root, { [`canon/changes/${C(9)}.md`]: change(9, "open", bad) });
      expect(findings(root).some((f) => f.rule === "file-invalid" && f.path.endsWith(`${C(9)}.md`))).toBe(true);
    }
  });
});

describe("releases merged into another", () => {
  test("BR-2521 BR-2509 BR-2505 BR-2527: rules, plans, features and criteria of releases merged into R-n count as R-n's, through chains; a dropped release with nowhere to go still strands its rules", () => {
    const root = project();
    write(root, {
      ...DOMAIN,
      [`canon/features/${F(2)}.md`]: feature(2),
      [`canon/releases/${R(2)}.md`]: release(2, `status: dropped\nmerged_into: ${R(3)}\n`),
      [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(5)}\nfeatures: [${F(2)}]\n`).replace("## 成功标准\n\n内容\n", "## 成功标准\n\n- S1 负责人试玩 R-3。（待负责人）\n"),
      [`canon/releases/${R(5)}.md`]: release(5, "status: active\n"),
      [`canon/rules/billing/${BR(6)}.md`]: rule(6, `release: ${R(2)}\n`, "planned"),
      [`canon/rules/billing/${BR(7)}.md`]: rule(7, `release: ${R(3)}\n`, "planned"),
      [`canon/rules/billing/${BR(8)}.md`]: rule(8, `feature: ${F(2)}\n`, "planned"),
    });
    expect(findings(root).filter((f) => f.rule === "release-dropped" || f.rule === "release-composition")).toEqual([]);
    const status = JSON.parse(canon(root, "release", "status", R(5), "--json").out) as { rules: { id: string }[] };
    expect(status.rules.map((r) => r.id)).toEqual([BR(6), BR(7), BR(8)]);
    expect(canon(root, "release", "ship", R(5)).code).toBe(1);
    const overview = canon(root, "overview").out;
    expect(overview).toContain(`并入 2 个版本：${R(2)}, ${R(3)}  成功标准 1 条：`);
    // reason: a merged release's criterion counts as R-5's and its owner's one is on the agenda (BR-2505, BR-2527)
    expect(overview).toMatch(/成功标准 1 条：已满足 0  未满足 0  待负责人 1/);
    expect(overview).toContain(`owner: 1: criterion:${R(3)}/S1`);
    write(root, { [`canon/releases/${R(6)}.md`]: release(6, `status: planned\nfeatures: [${F(2)}]\n`) });
    expect(findings(root).some((f) => f.rule === "release-composition" && f.message.includes(F(2)))).toBe(true);
    write(root, { [`canon/releases/${R(6)}.md`]: release(6, "status: planned\n"), [`canon/releases/${R(3)}.md`]: release(3, "status: dropped\n") });
    const stranded = findings(root).filter((f) => f.rule === "release-dropped").map((f) => f.path.split("/").pop());
    expect(stranded.sort()).toEqual([`${BR(6)}.md`, `${BR(7)}.md`]);
    write(root, { [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(2)}\n`) });
    expect(findings(root).some((f) => f.rule === "release-composition" && f.path.endsWith(`${R(2)}.md`))).toBe(true);
  });
});

describe("a shipped release keeps what was merged into it", () => {
  test("BR-2521: after R-5 ships, a rule tagged with a release merged into it cannot be retagged", () => {
    const root = project();
    write(root, { ...DOMAIN, [`canon/releases/${R(3)}.md`]: release(3, `status: dropped\nmerged_into: ${R(5)}\n`), [`canon/releases/${R(5)}.md`]: release(5, "status: active\n"), [`canon/releases/${R(6)}.md`]: release(6), [`canon/rules/billing/${BR(7)}.md`]: rule(7, `release: ${R(3)}\n`) });
    const sha = sh(root, "rev-parse", "HEAD").trim();
    write(root, { [`canon/releases/${R(5)}.md`]: release(5, `status: shipped\nshipped_at: ${sha}\n`) });
    expect(findings(root).filter((f) => f.rule === "release-frozen")).toEqual([]);
    write(root, { [`canon/rules/billing/${BR(7)}.md`]: rule(7, `release: ${R(6)}\n`) });
    expect(findings(root).some((f) => f.rule === "release-frozen" && f.path.endsWith(`${BR(7)}.md`))).toBe(true);
  });
});
