import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureGuard } from "../../install/githook.ts";
import { readCorpus } from "../documents/read.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../work/testkit.ts";
import { land } from "../../work/land/land.ts";
import { linksOf } from "./start.ts";
import { fingerprint } from "./links.ts";

// reason: these tests drive the canon CLI through spawned processes and walk git history (C-111)
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../../invocation/main.ts");
// Fixture ids are assembled at runtime, so the ids in fixture strings never count as references here (BR-2004).
const id = (p: string, n: number) => [p, n].join("-");
const B1 = id("BR", 1);
const B2 = id("BR", 2);
const B3 = id("BR", 3);
const B9 = id("BR", 9);
const B10 = id("BR", 10);
const D1 = id("D", 1);
const D2 = id("D", 2);
const C1 = id("C", 1);

const rule = (n: number, statement: string, o: { examples?: string; title?: string; status?: string; links?: Record<string, string> } = {}) =>
  `---\nid: ${id("BR", n)}\ntitle: ${o.title ?? `Rule ${n}`}\nstatus: ${o.status ?? "active"}\nuntested: fixture\n${o.links ? `links:\n${Object.entries(o.links).map(([k, v]) => `  ${k}: "${v}"`).join("\n")}\n` : ""}---\n\n## 规则\n\n${statement}\n\n## 例子\n\n${o.examples ?? "- a → b"}\n`;
const decision = (n: number, o: { background?: string; decide?: string; status?: string } = {}) =>
  `---\nid: ${id("D", n)}\ntitle: Decision ${n}\nstatus: ${o.status ?? "accepted"}\n---\n\n## 背景\n\n${o.background ?? "背景"}\n\n## 方案\n\n1. A：采用。\n2. B：否决。\n\n## 决定\n\n${o.decide ?? "采用 A。"}\n\n## 后果\n\n无。\n`;

const RULES = "canon/rules/billing";
const ruleFile = (n: number, domain = "billing") => `canon/rules/${domain}/${id("BR", n)}.md`;
const decisionFile = (n: number) => `canon/decisions/${id("D", n)}.md`;

function put(root: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** Writes the files and commits them; returns the commit id. */
function commit(root: string, files: Record<string, string>, message = "step"): string {
  put(root, files);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", message);
  return sh(root, "rev-parse", "HEAD");
}

/** A project with two domains and `files` committed on top; returns the root and that commit. */
function repo(files: Record<string, string>): { root: string; first: string } {
  const root = project();
  put(root, {
    [`${RULES}/README.md`]: "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n",
    "canon/rules/shipping/README.md": "---\ncode: [src/shipping]\n---\n# shipping\n\n## 术语\n\n- **运单**：寄出的包裹\n",
    "src/billing/.keep": "",
    "src/shipping/.keep": "",
  });
  return { root, first: commit(root, files, "first") };
}

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Suspect references as `from -> to`, read in-process against starting commit `since` (BR-2423). */
function suspects(root: string, since: string): string[] {
  const links = linksOf(root, readCorpus(root).corpus, since);
  if (!links.ok) throw new Error(links.error.message);
  return links.value.filter((l) => l.suspect).map((l) => `${l.from} -> ${l.to}`);
}

/** Sets links_since in canon/config.yaml and commits it, as a project does once (BR-2424). */
function startAt(root: string, since: string): void {
  const path = join(root, "canon/config.yaml");
  writeFileSync(path, `${readFileSync(path, "utf8").replace(/^links_since:.*\n/m, "")}links_since: ${since}\n`);
  sh(root, "commit", "-qam", "links_since");
}

const A_NAMES_B = `按 ${B2} 计算。`;
const ruleFp = (text: string) => fingerprint("rule", text.slice(text.indexOf("\n---\n") + 5));
const linksOfFile = (root: string, path: string) => readCorpus(root).corpus.docs.find((d) => d.path === path) as { links?: Record<string, string> } | undefined;

describe("suspect references", () => {
  test("BR-2423: a change to the named rule's 例子 makes the reference suspect; a title, front matter or planned status change does not; changing it back clears it; canon check is not affected", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    startAt(root, first);
    expect(suspects(root, first)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "二", { title: "Renamed", status: "planned" }) });
    expect(suspects(root, first)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "二", { examples: "- a → c" }) });
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`]);
    const check = canon(root, "check");
    expect([check.code, check.out]).toEqual([0, expect.stringContaining("ok:")]);
    commit(root, { [ruleFile(2)]: rule(2, "二") });
    expect(suspects(root, first)).toEqual([]);
  });

  test("BR-2423: retiring the named rule or superseding the named decision makes the reference suspect", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, `${A_NAMES_B}见 ${D2}。`), [ruleFile(2)]: rule(2, "二"), [decisionFile(2)]: decision(2) });
    commit(root, { [ruleFile(2)]: rule(2, "二", { status: "retired" }), [decisionFile(2)]: decision(2, { status: "superseded" }) });
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`, `${B1} -> ${D2}`]);
  });

  test("BR-2423: ids in backticks or code blocks are no reference; changes, retired rules and superseded decisions are not referrers", () => {
    const { root, first } = repo({
      [ruleFile(1)]: rule(1, `按 \`${B2}\` 计算。\n\n\`\`\`\n${B2}\n\`\`\``),
      [ruleFile(3)]: rule(3, A_NAMES_B, { status: "retired" }),
      [decisionFile(1)]: decision(1, { background: `见 ${B2}。`, status: "superseded" }),
      [`canon/changes/${C1}.md`]: `---\nid: ${C1}\ntitle: c\nstatus: open\nrules: []\n---\n\n## 为什么\n\n改 ${B2}。\n\n## 要改什么\n\nx\n\n## 任务\n\n- [ ] x\n`,
      [ruleFile(2)]: rule(2, "二"),
    });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    expect(suspects(root, first)).toEqual([]);
  });

  test("BR-2423: a decision's fingerprint is its 决定 section only, and a decision that names a rule is a referrer", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, `按 ${D2} 做。`), [decisionFile(2)]: decision(2), [decisionFile(1)]: decision(1, { background: `见 ${B2}。` }), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [decisionFile(2)]: decision(2, { background: "新的背景" }) });
    expect(suspects(root, first)).toEqual([]);
    commit(root, { [decisionFile(2)]: decision(2, { background: "新的背景", decide: "采用 B。" }), [ruleFile(2)]: rule(2, "改了") });
    expect(suspects(root, first)).toEqual([`${B1} -> ${D2}`, `${D1} -> ${B2}`]);
  });
});

describe("the starting commit of an unconfirmed reference", () => {
  test("BR-2424: a reference named at the starting commit compares with the named rule there; changes before it count as confirmed; editing the referring rule clears nothing", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    const since = commit(root, { [ruleFile(2)]: rule(2, "改了") });
    expect(suspects(root, since)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    expect(suspects(root, since)).toEqual([`${B1} -> ${B2}`]);
    commit(root, { [ruleFile(1)]: rule(1, `${A_NAMES_B}另外一句。`, { examples: "- x → y" }) });
    put(root, { [ruleFile(1)]: rule(1, `${A_NAMES_B}再一句。`) });
    expect(suspects(root, since)).toEqual([`${B1} -> ${B2}`]);
  });

  test("BR-2424: a reference written after the starting commit is suspect until confirmed, committed or not", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, "一"), [ruleFile(3)]: rule(3, "三"), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(1)]: rule(1, `一。${A_NAMES_B}`) });
    put(root, { [ruleFile(3)]: rule(3, `三。${A_NAMES_B}`) });
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`, `${B3} -> ${B2}`]);
  });

  test("BR-2424: the result depends on the starting commit, not on how much history the clone holds; moving the referring rule keeps it", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    renameSync(join(root, ruleFile(1)), join(root, ruleFile(1, "shipping")));
    commit(root, {});
    startAt(root, first);
    const full = canon(root, "links", "list", "--json");
    expect(JSON.parse(full.out)).toEqual([{ from: B1, to: B2, basis: "start", since: first }]);
    const shallow = mkdtempSync(join(tmpdir(), "canon-links-shallow-"));
    sh(tmpdir(), "clone", "-q", "--depth", "1", `file://${root}`, shallow);
    const r = canon(shallow, "links", "list");
    expect([r.code, r.err]).toEqual([4, expect.stringContaining(`links_since ${first.slice(0, 9)} is not in the history of HEAD`)]);
  });

  test("BR-2424: without links_since every links command fails with exit 4 and says how to set it; a value that is no full commit id fails reading the config with exit 2", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    const r = canon(root, "links", "list");
    expect([r.code, r.err]).toEqual([4, expect.stringContaining("canon/config.yaml has no links_since")]);
    expect(canon(root, "links", "confirm", B1, B2).code).toBe(4);
    writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}links_since: ABC123\n`);
    const bad = canon(root, "links", "list");
    expect([bad.code, bad.err]).toEqual([2, expect.stringContaining("links_since")]);
  });

  test("BR-2424: a repository without a commit has nothing suspect; outside a repository the starting commit cannot be read (exit 4)", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-links-"));
    put(root, { [`${RULES}/README.md`]: "# billing\n", [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    sh(root, "init", "-q", "-b", "main");
    const empty = linksOf(root, readCorpus(root).corpus, undefined);
    expect(empty.ok ? empty.value.map((l) => [l.from, l.to, l.suspect]) : empty.error).toEqual([[B1, B2, false]]);
    rmSync(join(root, ".git"), { recursive: true });
    const outside = linksOf(root, readCorpus(root).corpus, undefined);
    expect(outside.ok ? "read" : outside.error.code).toBe("io");
  });
});

describe("canon links confirm", () => {
  test("BR-2425: confirming writes the named rule's fingerprint into links, drops keys the prose no longer names, and the reference is no longer suspect until the rule changes again", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B, { links: { [B3]: "0123456789abcdef" } }), [ruleFile(2)]: rule(2, "二") });
    startAt(root, first);
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    const r = canon(root, "links", "confirm", B1, B2);
    const fp = ruleFp(rule(2, "改了"));
    expect([r.code, r.out]).toEqual([0, `confirmed ${B1} -> ${B2} (${fp})\n`]);
    const text = readFileSync(join(root, ruleFile(1)), "utf8");
    expect(text).toContain(`links:\n  ${B2}: ${fp}\n`);
    expect(text).not.toContain(B3);
    expect(text.slice(text.indexOf("\n---\n"))).toBe(rule(1, A_NAMES_B).slice(rule(1, A_NAMES_B).indexOf("\n---\n")));
    expect(suspects(root, first)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`]);
  });

  test("BR-2425: after the referring rule was fixed for the change, confirm still writes the record", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    startAt(root, first);
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    commit(root, { [ruleFile(1)]: rule(1, A_NAMES_B, { examples: "- a → b\n- c → d" }) });
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`]);
    const r = canon(root, "links", "confirm", B1, B2);
    expect([r.code, r.out]).toEqual([0, `confirmed ${B1} -> ${B2} (${ruleFp(rule(2, "改了"))})\n`]);
    expect(suspects(root, first)).toEqual([]);
  });

  test("BR-2425: a record decides alone: a confirmation and an edit of the referring rule on a branch, the named rule changed again on main, stay suspect after rebase", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    sh(root, "checkout", "-q", "-b", "work");
    put(root, { "canon/config.yaml": `${readFileSync(join(root, "canon/config.yaml"), "utf8")}links_since: ${first}\n` });
    expect(canon(root, "links", "confirm", B1, B2).code).toBe(0);
    put(root, { [ruleFile(1)]: readFileSync(join(root, ruleFile(1)), "utf8").replace(A_NAMES_B, `${A_NAMES_B}另外一句。`) });
    commit(root, {}, "confirm and edit");
    sh(root, "checkout", "-q", "main");
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    sh(root, "checkout", "-q", "work");
    sh(root, "rebase", "-q", "main");
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`]);
  });

  test("BR-2425: a reference that is not suspect is left alone; unknown ids, an unnamed document or a retired referrer write nothing and exit 3 or 2", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二"), [ruleFile(3)]: rule(3, A_NAMES_B, { status: "retired" }) });
    startAt(root, first);
    const before = readFileSync(join(root, ruleFile(1)), "utf8");
    const fine = canon(root, "links", "confirm", B1, B2);
    expect([fine.code, fine.out]).toEqual([0, `${B1} -> ${B2} is not suspect; nothing written\n`]);
    expect(canon(root, "links", "confirm", B1, B3).code).toBe(3);
    expect(canon(root, "links", "confirm", B1, B9).code).toBe(3);
    expect(canon(root, "links", "confirm", B9, B2).code).toBe(3);
    const retired = canon(root, "links", "confirm", B3, B2);
    expect([retired.code, retired.err]).toEqual([2, expect.stringContaining("retired")]);
    expect(readFileSync(join(root, ruleFile(1)), "utf8")).toBe(before);
    expect(sh(root, "status", "--short")).toBe("");
  });

  test("BR-2425: in the guarded primary checkout confirm refuses with exit 1 and writes nothing", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    startAt(root, first);
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    expect(ensureGuard(root, "main").ok).toBe(true);
    const r = canon(root, "links", "confirm", B1, B2);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("canon work start")]);
    expect(sh(root, "status", "--short")).toBe("");
  });

  test("BR-2425: a links value that is not 16 hex characters is file-invalid", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B, { links: { [B2]: "abc" } }), [ruleFile(2)]: rule(2, "二") });
    const r = canon(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`file-invalid\\s+${ruleFile(1)}: .*links`));
  });
});

describe("canon check and links", () => {
  test("BR-2426: a links key the prose does not name (or names only in backticks, or that does not exist) is link-stale; a reference without a key is fine", () => {
    const fp = "0123456789abcdef";
    const fine = repo({ [ruleFile(1)]: rule(1, `${A_NAMES_B}见 ${B3}。`, { links: { [B2]: fp } }), [ruleFile(2)]: rule(2, "二"), [ruleFile(3)]: rule(3, "三") });
    expect(canon(fine.root, "check").code).toBe(0);
    const stale = repo({ [ruleFile(1)]: rule(1, `按 \`${B2}\` 计算。`, { links: { [B2]: fp, [B9]: fp } }), [ruleFile(2)]: rule(2, "二") });
    const r = canon(stale.root, "check");
    expect(r.code).toBe(1);
    const lines = r.out.split("\n").filter((l) => l.startsWith("link-stale"));
    expect(lines).toEqual([expect.stringContaining(`${ruleFile(1)}: \`links\` records ${B2}`), expect.stringContaining(`records ${B9}`)]);
  });
});

/** A project whose starting commit's version of BR-2 is gone from the object store, so it cannot be read. */
function brokenStart(): string {
  const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
  const blob = sh(root, "rev-parse", `HEAD:${ruleFile(2)}`);
  startAt(root, first);
  commit(root, { [ruleFile(2)]: rule(2, "改了") });
  rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  return root;
}

describe("canon links list", () => {
  test("BR-2427: one line per suspect reference by referring then named id, saying why, the count last, exit 0; --json gives from, to, basis and the starting commit; none says so", () => {
    const { root, first } = repo({
      [ruleFile(10)]: rule(10, A_NAMES_B),
      [ruleFile(9)]: rule(9, `${A_NAMES_B}见 ${D1}。`),
      [ruleFile(2)]: rule(2, "二"),
      [ruleFile(3)]: rule(3, "三"),
      [decisionFile(1)]: decision(1, { background: `见 ${B2}。` }),
    });
    startAt(root, first);
    const none = canon(root, "links", "list");
    expect([none.code, none.out]).toEqual([0, "no suspect references\n"]);
    expect(canon(root, "links", "list", "--json").out.trim()).toBe("[]");
    commit(root, { [ruleFile(3)]: rule(3, `按 ${D1} 来。`) });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    expect(canon(root, "links", "confirm", B10, B2).code).toBe(0);
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    const r = canon(root, "links", "list");
    const s = first.slice(0, 7);
    expect([r.code, r.out]).toEqual([
      0,
      [
        `${B3} -> ${D1}: ${D1} named after ${s} and never confirmed`,
        `${B9} -> ${B2}: ${B2} changed since ${s}`,
        `${B10} -> ${B2}: ${B2} changed since it was confirmed`,
        `${D1} -> ${B2}: ${B2} changed since ${s}`,
        "4 suspect reference(s) in 4 document(s); re-read the named document, fix the referring one if needed, then: canon links confirm <referring> <named>",
        "",
      ].join("\n"),
    ]);
    expect(JSON.parse(canon(root, "links", "list", "--json").out).slice(0, 3)).toEqual([
      { from: B3, to: D1, basis: "new", since: first },
      { from: B9, to: B2, basis: "start", since: first },
      { from: B10, to: B2, basis: "confirmed", since: first },
    ]);
  });

  test("BR-2427: a starting commit that cannot be read exits 4", () => {
    const r = canon(brokenStart(), "links", "list");
    expect([r.code, r.err]).toEqual([4, expect.stringContaining("git cat-file --batch")]);
  });
});

describe("canon context and references", () => {
  test("BR-2428: a rule's context lists what it names and what names it, marking the suspect ones; changes do not count; a retired rule is not tracked; a path has no section", () => {
    const { root, first } = repo({
      [ruleFile(1)]: rule(1, `${A_NAMES_B}见 ${D1}。`),
      [ruleFile(2)]: rule(2, "二"),
      [ruleFile(3)]: rule(3, `按 ${B1} 来。`),
      [ruleFile(9)]: rule(9, `按 ${B2} 来。`, { status: "retired" }),
      [decisionFile(1)]: decision(1),
      [`canon/changes/${C1}.md`]: `---\nid: ${C1}\ntitle: c\nstatus: open\nrules: []\n---\n\n## 为什么\n\n改 ${B3}。\n\n## 要改什么\n\nx\n\n## 任务\n\n- [ ] x\n`,
    });
    startAt(root, first);
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    const hint = `[suspect: ${B2} changed since ${first.slice(0, 7)}; canon links confirm ${B1} ${B2}]`;
    const section = (out: string) => out.slice(out.indexOf("# References"), out.indexOf("\n\n", out.indexOf("Named by:")));
    expect(section(canon(root, "context", B1).out)).toBe(["# References", "", "Names:", `- ${B2} Rule 2 ${hint}`, `- ${D1} Decision 1`, "Named by:", `- ${B3} Rule 3`].join("\n"));
    expect(section(canon(root, "context", B2).out)).toBe(["# References", "", "Names:", "(none)", "Named by:", `- ${B1} Rule 1 ${hint}`].join("\n"));
    expect(section(canon(root, "context", B3).out)).toBe(["# References", "", "Names:", `- ${B1} Rule 1`, "Named by:", "(none)"].join("\n"));
    expect(section(canon(root, "context", B9).out)).toBe(["# References", "", "Names:", `(not tracked: ${B9} is retired)`, "Named by:", "(none)"].join("\n"));
    expect(canon(root, "context", "src/billing").out).not.toContain("# References");
  });

  test("BR-2428: a starting commit that cannot be read, or none set, is said in the section, the rest is printed, and the exit code is 4", () => {
    const r = canon(brokenStart(), "context", B1);
    expect(r.code).toBe(4);
    expect(r.out).toContain(`# ${B1} Rule 1`);
    expect(r.out).toContain("# References\n\ncanon links: git cat-file --batch");
    const unset = canon(repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") }).root, "context", B1);
    expect([unset.code, unset.out]).toEqual([4, expect.stringContaining("# References\n\ncanon links: canon/config.yaml has no links_since")]);
  });
});

describe("canon brief and references", () => {
  test("BR-2429: brief in a change's worktree lists the suspect references on what the change names; elsewhere it counts them; none says nothing", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二"), [ruleFile(3)]: rule(3, `按 ${B9} 来。`), [ruleFile(9)]: rule(9, "九") });
    startAt(root, first);
    expect(canon(root, "brief").out).not.toContain("suspect reference");
    commit(root, { [ruleFile(2)]: rule(2, "改了"), [ruleFile(9)]: rule(9, "改了") });
    expect(canon(root, "brief").out).toContain("\n2 suspect reference(s): canon links list\n");
    const s = startNew(root, "Touch two");
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}-`))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("rules: []", `rules:\n  - ${B2}`));
    const lines = canon(s.worktree, "brief").out.split("\n").filter((l) => l.startsWith("Suspect reference"));
    expect(lines).toEqual([`Suspect reference: ${B1} -> ${B2} (${B2} changed since ${first.slice(0, 7)}; canon links confirm ${B1} ${B2})`]);
  });

  test("BR-2429: a starting commit that cannot be read, or none set, is one line in brief, which goes on", () => {
    const r = canon(brokenStart(), "brief");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\ncanon links: git cat-file --batch");
    const unset = canon(repo({ [ruleFile(1)]: rule(1, A_NAMES_B) }).root, "brief");
    expect([unset.code, unset.out]).toEqual([0, expect.stringContaining("\ncanon links: canon/config.yaml has no links_since")]);
  });
});

describe("references a landing adds", () => {
  /** A project at `first` with links_since set, then a change that adds BR-3 naming BR-2 and has BR-1's existing reference. */
  function landingProject() {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二"), [ruleFile(9)]: rule(9, "九") });
    startAt(root, first);
    const s = startNew(root, "Name two");
    put(s.worktree, { [ruleFile(3)]: rule(3, `${A_NAMES_B}见 ${B9}。`), [ruleFile(1)]: rule(1, `${A_NAMES_B}另外一句。`) });
    const dir = join(s.worktree, "canon/changes");
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith(`${s.change}-`))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("\n## 任务", `\n## 验收\n\n- ${B1}：读 → 对\n- ${B3}：读 → 对\n\n## 任务`));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "name two");
    return { root, first, s };
  }

  test("BR-2440: --finish records each reference the change added with the named rule as the branch had it, in the close commit; a rule main changed meanwhile shows as suspect", async () => {
    const { root, first, s } = landingProject();
    commit(root, { [ruleFile(2)]: rule(2, "main 改了") }, "main moves");
    const lines: string[] = [];
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, (l) => lines.push(l));
    expect(out.kind).toBe("landed");
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe(`canon: close ${s.change}`);
    expect(sh(root, "show", "--name-only", "--format=", "main").split("\n").sort()).toEqual([ruleFile(3), expect.stringContaining(`canon/changes/${s.change}`)].sort());
    sh(root, "checkout", "-q", "main");
    expect(linksOfFile(root, ruleFile(3))?.links).toEqual({ [B2]: ruleFp(rule(2, "二")), [B9]: ruleFp(rule(9, "九")) });
    expect(linksOfFile(root, ruleFile(1))?.links).toBeUndefined();
    expect(suspects(root, first)).toEqual([`${B1} -> ${B2}`, `${B3} -> ${B2}`]);
    expect(lines).toContain(`confirmed 2 reference(s) this change added, in ${s.change}'s close commit: ${B3} -> ${B2}, ${B9}`);
  });

  test("BR-2440: a landing that does not reach main takes the records back with its close commit", async () => {
    const { s } = landingProject();
    put(s.worktree, { FAIL: "" });
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "fail the floor");
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out).toMatchObject({ kind: "refused", reason: "floor" });
    expect(sh(s.worktree, "log", "-1", "--format=%s")).toBe("fail the floor");
    expect(readFileSync(join(s.worktree, ruleFile(3)), "utf8")).not.toContain("links:");
    expect(sh(s.worktree, "status", "--short")).toBe("");
  });
});
