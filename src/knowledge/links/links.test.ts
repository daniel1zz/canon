import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureGuard } from "../../install/githook.ts";
import { readCorpus } from "../documents/read.ts";
import { project, sh, startNew } from "../../work/testkit.ts";
import { linksOf } from "./history.ts";
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

/** Suspect references as `from -> to`, read in-process (BR-2423). */
function suspects(root: string): string[] {
  const links = linksOf(root, readCorpus(root).corpus);
  if (!links.ok) throw new Error(links.error.message);
  return links.value.filter((l) => l.suspect).map((l) => `${l.from} -> ${l.to}`);
}

const A_NAMES_B = `按 ${B2} 计算。`;
const ruleFp = (text: string) => fingerprint("rule", text.slice(text.indexOf("\n---\n") + 5));

describe("suspect references", () => {
  test("BR-2423: a change to the named rule's 例子 makes the reference suspect; a title, status or front matter change does not; changing it back clears it; canon check is not affected", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    expect(suspects(root)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "二", { title: "Renamed", status: "planned" }) });
    expect(suspects(root)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "二", { examples: "- a → c" }) });
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
    const check = canon(root, "check");
    expect([check.code, check.out]).toEqual([0, expect.stringContaining("ok:")]);
    commit(root, { [ruleFile(2)]: rule(2, "二") });
    expect(suspects(root)).toEqual([]);
  });

  test("BR-2423: ids in backticks or code blocks are no reference; changes, retired rules and superseded decisions are not referrers", () => {
    const { root } = repo({
      [ruleFile(1)]: rule(1, `按 \`${B2}\` 计算。\n\n\`\`\`\n${B2}\n\`\`\``),
      [ruleFile(3)]: rule(3, A_NAMES_B, { status: "retired" }),
      [decisionFile(1)]: decision(1, { background: `见 ${B2}。`, status: "superseded" }),
      [`canon/changes/${C1}.md`]: `---\nid: ${C1}\ntitle: c\nstatus: open\nrules: []\n---\n\n## 为什么\n\n改 ${B2}。\n\n## 要改什么\n\nx\n\n## 任务\n\n- [ ] x\n`,
      [ruleFile(2)]: rule(2, "二"),
    });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    expect(suspects(root)).toEqual([]);
  });

  test("BR-2423: a decision's fingerprint is its 决定 section only, and a decision that names a rule is a referrer", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, `按 ${D2} 做。`), [decisionFile(2)]: decision(2), [decisionFile(1)]: decision(1, { background: `见 ${B2}。` }), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [decisionFile(2)]: decision(2, { background: "新的背景" }) });
    expect(suspects(root)).toEqual([]);
    commit(root, { [decisionFile(2)]: decision(2, { background: "新的背景", decide: "采用 B。" }), [ruleFile(2)]: rule(2, "改了") });
    expect(suspects(root)).toEqual([`${B1} -> ${D2}`, `${D1} -> ${B2}`]);
  });
});

describe("the history baseline of an unconfirmed reference", () => {
  test("BR-2424: an edit to the referring rule's 规则 after the change clears it; a title-only edit does not", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    commit(root, { [ruleFile(1)]: rule(1, A_NAMES_B, { title: "Only the title" }) });
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
    commit(root, { [ruleFile(1)]: rule(1, `${A_NAMES_B}另外一句。`) });
    expect(suspects(root)).toEqual([]);
  });

  test("BR-2424: a reference written after the change, or in the same commit as it, is not suspect", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, "一"), [ruleFile(3)]: rule(3, "三"), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    commit(root, { [ruleFile(1)]: rule(1, `一。${A_NAMES_B}`) });
    commit(root, { [ruleFile(3)]: rule(3, `三。${A_NAMES_B}`, { examples: "- x → y" }), [ruleFile(2)]: rule(2, "又改了") });
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
  });

  test("BR-2424: the working tree is the newest step: an uncommitted edit to the referring rule's 规则 clears it, an uncommitted title edit does not", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    put(root, { [ruleFile(1)]: rule(1, A_NAMES_B, { title: "Only the title" }) });
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
    put(root, { [ruleFile(1)]: rule(1, `${A_NAMES_B}另外一句。`) });
    expect(suspects(root)).toEqual([]);
  });

  test("BR-2424: moving the referring rule to another domain keeps its baseline commit", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    renameSync(join(root, ruleFile(1)), join(root, ruleFile(1, "shipping")));
    commit(root, {});
    const r = canon(root, "links", "list", "--json");
    expect(JSON.parse(r.out)).toEqual([{ from: B1, to: B2, since: first }]);
  });

  test("BR-2424: a repository without a commit has nothing suspect; outside a repository the history cannot be read (exit 4)", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-links-"));
    put(root, { [`${RULES}/README.md`]: "# billing\n", [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    sh(root, "init", "-q", "-b", "main");
    const empty = linksOf(root, readCorpus(root).corpus);
    expect(empty.ok ? empty.value.map((l) => [l.from, l.to, l.suspect]) : empty.error).toEqual([[B1, B2, false]]);
    rmSync(join(root, ".git"), { recursive: true });
    const outside = linksOf(root, readCorpus(root).corpus);
    expect(outside.ok ? "read" : outside.error.code).toBe("io");
  });
});

describe("canon links confirm", () => {
  test("BR-2425: confirming writes the named rule's fingerprint into links, drops keys the prose no longer names, and the reference is no longer suspect until the rule changes again", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B, { links: { [B3]: "0123456789abcdef" } }), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    const r = canon(root, "links", "confirm", B1, B2);
    const fp = ruleFp(rule(2, "改了"));
    expect([r.code, r.out]).toEqual([0, `confirmed ${B1} -> ${B2} (${fp})\n`]);
    const text = readFileSync(join(root, ruleFile(1)), "utf8");
    expect(text).toContain(`links:\n  ${B2}: ${fp}\n`);
    expect(text).not.toContain(B3);
    expect(text.slice(text.indexOf("\n---\n"))).toBe(rule(1, A_NAMES_B).slice(rule(1, A_NAMES_B).indexOf("\n---\n")));
    expect(suspects(root)).toEqual([]);
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
  });

  test("BR-2425: a confirmation made on a branch before the named rule changed again on main stays suspect after rebase; an edit to the referring rule's 规则 clears it", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    sh(root, "checkout", "-q", "-b", "work");
    expect(canon(root, "links", "confirm", B1, B2).code).toBe(0);
    commit(root, {}, "confirm");
    sh(root, "checkout", "-q", "main");
    commit(root, { [ruleFile(2)]: rule(2, "又改了") });
    sh(root, "checkout", "-q", "work");
    sh(root, "rebase", "-q", "main");
    expect(suspects(root)).toEqual([`${B1} -> ${B2}`]);
    commit(root, { [ruleFile(1)]: readFileSync(join(root, ruleFile(1)), "utf8").replace(A_NAMES_B, `${A_NAMES_B}另外一句。`) });
    expect(suspects(root)).toEqual([]);
  });

  test("BR-2425: a reference that is not suspect is left alone; unknown ids, an unnamed document or a retired referrer write nothing and exit 3 or 2", () => {
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二"), [ruleFile(3)]: rule(3, A_NAMES_B, { status: "retired" }) });
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
    const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
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

/** A project whose first version of BR-2 is gone from the object store, so the history cannot be read. */
function brokenHistory(): string {
  const { root } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二") });
  const blob = sh(root, "rev-parse", `HEAD:${ruleFile(2)}`);
  commit(root, { [ruleFile(2)]: rule(2, "改了") });
  rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  return root;
}

describe("canon links list", () => {
  test("BR-2427: one line per suspect reference by referring then named id, the count last, exit 0; --json gives from, to and the full commit; none says so", () => {
    const { root, first } = repo({
      [ruleFile(10)]: rule(10, A_NAMES_B),
      [ruleFile(9)]: rule(9, `${A_NAMES_B}见 ${D1}。`),
      [ruleFile(2)]: rule(2, "二"),
      [decisionFile(1)]: decision(1, { background: `见 ${B2}。` }),
    });
    const none = canon(root, "links", "list");
    expect([none.code, none.out]).toEqual([0, "no suspect references\n"]);
    expect(canon(root, "links", "list", "--json").out.trim()).toBe("[]");
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    const r = canon(root, "links", "list");
    const s = first.slice(0, 7);
    expect([r.code, r.out]).toEqual([
      0,
      [
        `${B9} -> ${B2}: ${B2} changed since ${s}`,
        `${B10} -> ${B2}: ${B2} changed since ${s}`,
        `${D1} -> ${B2}: ${B2} changed since ${s}`,
        "3 suspect reference(s) in 3 document(s); re-read the named document, fix the referring one if needed, then: canon links confirm <referring> <named>",
        "",
      ].join("\n"),
    ]);
    expect(JSON.parse(canon(root, "links", "list", "--json").out)[0]).toEqual({ from: B9, to: B2, since: first });
  });

  test("BR-2427: a history that cannot be read exits 4", () => {
    const r = canon(brokenHistory(), "links", "list");
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
    commit(root, { [ruleFile(2)]: rule(2, "改了") });
    const hint = `[suspect: ${B2} changed since ${first.slice(0, 7)}; canon links confirm ${B1} ${B2}]`;
    const section = (out: string) => out.slice(out.indexOf("# References"), out.indexOf("\n\n", out.indexOf("Named by:")));
    expect(section(canon(root, "context", B1).out)).toBe(["# References", "", "Names:", `- ${B2} Rule 2 ${hint}`, `- ${D1} Decision 1`, "Named by:", `- ${B3} Rule 3`].join("\n"));
    expect(section(canon(root, "context", B2).out)).toBe(["# References", "", "Names:", "(none)", "Named by:", `- ${B1} Rule 1 ${hint}`].join("\n"));
    expect(section(canon(root, "context", B3).out)).toBe(["# References", "", "Names:", `- ${B1} Rule 1`, "Named by:", "(none)"].join("\n"));
    expect(section(canon(root, "context", B9).out)).toBe(["# References", "", "Names:", `(not tracked: ${B9} is retired)`, "Named by:", "(none)"].join("\n"));
    expect(canon(root, "context", "src/billing").out).not.toContain("# References");
  });

  test("BR-2428: a history that cannot be read is said in the section, the rest is printed, and the exit code is 4", () => {
    const r = canon(brokenHistory(), "context", B1);
    expect(r.code).toBe(4);
    expect(r.out).toContain(`# ${B1} Rule 1`);
    expect(r.out).toContain("# References\n\ncanon links: git cat-file --batch");
  });
});

describe("canon brief and references", () => {
  test("BR-2429: brief in a change's worktree lists the suspect references on what the change names; elsewhere it counts them; none says nothing", () => {
    const { root, first } = repo({ [ruleFile(1)]: rule(1, A_NAMES_B), [ruleFile(2)]: rule(2, "二"), [ruleFile(3)]: rule(3, `按 ${B9} 来。`), [ruleFile(9)]: rule(9, "九") });
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

  test("BR-2429: a history that cannot be read is one line in brief, which goes on", () => {
    const r = canon(brokenHistory(), "brief");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\ncanon links: git cat-file --batch");
  });
});
