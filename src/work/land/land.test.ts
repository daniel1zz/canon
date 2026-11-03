import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, takeClaim } from "../claims/claims.ts";
import { enqueue, finishEntry, tryTurn } from "./queue.ts";
import { handoffs, writeHandoff } from "../session/handoffs.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { clean, start, stop } from "../session/session.ts";
import { land, LAND_MARKER } from "./land.ts";
import { ensureGuard } from "../../cli/install/githook.ts";
import { processOf, type Proc } from "../claims/liveness.ts";

import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

describe("rule review at land", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    return { root, promptFile };
  }

  test("BR-2009 BR-2036: a block verdict on changed rule text refuses the landing; the reviewer saw the whole domain and the index of every rule", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("is vague");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("# Domain: billing");
    expect(prompt).toContain(`- ${id} [billing] Refunds`);
    expect(prompt).toContain("language the documents are written in");
    expect(prompt).toContain("One rule is one trigger"); // the split criterion of D-5
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2009: a reviewer that fails to run refuses the landing", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: "exit 3"\n`);
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(out.kind === "refused" && out.message).toContain("could not run");
  });

  test("BR-2074: changed rule text without a configured reviewer lands with a notice and a review.skip event", async () => {
    const root = project();
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n");
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "src/billing/.keep"), ""); // the domain's code path exists (BR-2079)
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "domain");
    const s = startNew(root, "New rule");
    const id = ["BR", 1].join("-");
    writeFileSync(join(s.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds are fine.\n`);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "rule");
    const lines: string[] = [];
    expect((await land(ws(s.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(lines.join("\n")).toContain("review: not configured");
    expect(ws(root).db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.skip'").get()?.n).toBe(1);
  });

  test("BR-2009: changing only a domain README is reviewed, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("block");
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Readme only");
    writeFileSync(join(s.worktree, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nRules here are optional.\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(s.worktree, "commit", "-qam", "readme");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    expect(readFileSync(promptFile, "utf8")).toContain("Rules here are optional.");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2009: deleting a rule file is reviewed with the text it had on main, and a block refuses it", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`);
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"block","findings":["deleting it drops a promise"]}'''\n`);
    sh(root, "commit", "-qam", "blocking reviewer");
    const s = startNew(root, "Delete rule");
    sh(s.worktree, "rm", "-q", `canon/rules/billing/${id}.md`);
    sh(s.worktree, "commit", "-qm", "delete");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("review");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/${id}.md`);
    expect(prompt).toContain("Refunds within 30 days.");
  });

  test("BR-2009: a rule file moved with identical content is not reviewed; moved and edited is reviewed as deleted plus added", async () => {
    const { root, promptFile } = reviewedProject("ok");
    const id = ["BR", 1].join("-");
    const text = `---\nid: ${id}\ntitle: Refunds\nuntested: demo\n---\n## 规则\n\nRefunds within 30 days.\n`;
    const seed = startNew(root, "Seed rule");
    writeFileSync(join(seed.worktree, `canon/rules/billing/${id}.md`), text);
    mkdirSync(join(seed.worktree, "canon/rules/billing/refunds"), { recursive: true });
    writeFileSync(join(seed.worktree, "canon/rules/billing/refunds/README.md"), "# billing/refunds\n\n## 术语\n\n- **退款**：钱退回\n");
    sh(seed.worktree, "add", "-A");
    sh(seed.worktree, "commit", "-qm", "rule");
    expect((await land(ws(seed.worktree), FAST, quiet)).kind).toBe("landed");
    rmSync(promptFile, { force: true });

    const move = startNew(root, "Move rule");
    sh(move.worktree, "mv", `canon/rules/billing/${id}.md`, `canon/rules/billing/refunds/${id}.md`);
    sh(move.worktree, "commit", "-qm", "move");
    const lines: string[] = [];
    expect((await land(ws(move.worktree), FAST, (l) => lines.push(l))).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
    expect(lines).toContain("review: 1 file(s) only moved, not reviewed");

    const edit = startNew(root, "Move and edit");
    sh(edit.worktree, "mv", `canon/rules/billing/refunds/${id}.md`, `canon/rules/billing/${id}.md`);
    writeFileSync(join(edit.worktree, `canon/rules/billing/${id}.md`), text.replace("30", "31"));
    sh(edit.worktree, "commit", "-qam", "move and edit");
    expect((await land(ws(edit.worktree), FAST, quiet)).kind).toBe("landed");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Refunds within 31 days.");
    expect(prompt).toContain(`## ${id} — deleted canon/rules/billing/refunds/${id}.md`);
  });

  test("BR-2010: the reviewer is not asked when no rule or decision text changed", async () => {
    const { root, promptFile } = reviewedProject("block");
    const s = startNew(root, "Code only");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "code");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("work land", () => {
  test("BR-2017 BR-2039: lands a committed branch: main moves and the primary checkout's files follow", async () => {
    const root = project();
    const s = startNew(root, "Add four");
    writeFileSync(join(s.worktree, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(s.worktree, "commit", "-qam", "four");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).toBe(sh(s.worktree, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "app.txt"), "utf8")).toContain("four");
  });

  test("BR-2125: with canon's git guard installed, land still moves main, both when main is checked out and when it is not, and leaves no marker behind", async () => {
    const root = project();
    expect(ensureGuard(root, "main")).toEqual({ ok: true, value: true });
    writeFileSync(join(root, "app.txt"), "direct\n");
    expect(Bun.spawnSync(["git", "commit", "-qam", "direct"], { cwd: root }).exitCode).not.toBe(0); // the guard is live
    sh(root, "checkout", "-q", "--", "app.txt");
    const a = startNew(root, "Checked out");
    writeFileSync(join(a.worktree, "a.txt"), "a\n");
    sh(a.worktree, "add", "a.txt");
    sh(a.worktree, "commit", "-qm", "a");
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(join(root, "a.txt"))).toBe(true); // the primary checkout followed main (BR-2039)
    sh(root, "checkout", "-q", "--detach");
    const b = startNew(root, "Detached");
    writeFileSync(join(b.worktree, "b.txt"), "b\n");
    sh(b.worktree, "add", "b.txt");
    sh(b.worktree, "commit", "-qm", "b");
    expect((await land(ws(b.worktree), FAST, quiet)).kind).toBe("landed");
    expect(sh(root, "rev-parse", "main")).toBe(sh(b.worktree, "rev-parse", "HEAD"));
    expect(process.env[LAND_MARKER]).toBeUndefined();
  });

  test("BR-2013 BR-2014 BR-2015: refuses uncommitted work, a red floor and a rebase conflict, leaving main untouched", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");

    const a = startNew(root, "Dirty");
    writeFileSync(join(a.worktree, "app.txt"), "changed\n");
    const dirty = await land(ws(a.worktree), FAST, quiet);
    expect(dirty.kind === "refused" && dirty.reason).toBe("dirty");

    const b = startNew(root, "Red");
    writeFileSync(join(b.worktree, "FAIL"), "x");
    sh(b.worktree, "add", "FAIL");
    sh(b.worktree, "commit", "-qm", "red");
    const red = await land(ws(b.worktree), FAST, quiet);
    expect(red.kind === "refused" && red.reason).toBe("floor");
    expect(sh(root, "rev-parse", "main")).toBe(before);

    const c = startNew(root, "Edit two");
    const d = startNew(root, "Edit two again");
    writeFileSync(join(c.worktree, "app.txt"), "one\nTWO\nthree\n");
    sh(c.worktree, "commit", "-qam", "c");
    writeFileSync(join(d.worktree, "app.txt"), "one\n2\nthree\n");
    sh(d.worktree, "commit", "-qam", "d");
    expect((await land(ws(c.worktree), FAST, quiet)).kind).toBe("landed");
    const conflict = await land(ws(d.worktree), FAST, quiet);
    expect(conflict.kind === "refused" && conflict.reason).toBe("conflict");
    expect(sh(d.worktree, "status", "--porcelain")).toBe(""); // rebase was aborted, work intact
  });

  test("BR-2017: main that moved while the floor ran stays where it was moved, and the landing is refused", async () => {
    const root = project();
    const s = startNew(root, "Racing");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "git -C ${root} commit -q --allow-empty -m moved-meanwhile"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that moves main");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("main-moved");
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("moved-meanwhile");
  });

  test("BR-2106: a commit made in the worktree while the floor runs is refused as moved-during-land, naming it; main stays", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Sneaky commit");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "git commit -q --allow-empty -m sneaky"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that commits");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("moved-during-land");
    expect(out.kind === "refused" && out.message).toContain("sneaky");
    expect(sh(root, "rev-parse", "main")).toBe(before);
  });

  test("BR-2106: an uncommitted file left in the worktree after the floor is refused as moved-during-land, naming it", async () => {
    const root = project();
    const s = startNew(root, "Stray file");
    writeFileSync(join(s.worktree, "canon/config.yaml"), `floor: "echo x > stray.txt"\ntests: []\n`);
    sh(s.worktree, "commit", "-qam", "floor that writes a file");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("moved-during-land");
    expect(out.kind === "refused" && out.message).toContain("stray.txt");
  });

  test("BR-2106: a floor that leaves HEAD and the worktree as they were lands the tested commit", async () => {
    const root = project();
    const s = startNew(root, "Clean floor");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "landed" && out.sha).toBe(sh(s.worktree, "rev-parse", "HEAD"));
  });

  test("BR-2105: uncommitted edits made while waiting in the queue are refused as dirty, naming the files, not as a conflict", async () => {
    const root = project();
    const s = startNew(root, "Edited while waiting");
    writeFileSync(join(s.worktree, "app.txt"), "one\nTWO\nthree\n");
    sh(s.worktree, "commit", "-qam", "two");
    writeFileSync(join(root, "app.txt"), "one\n2\nthree\n");
    sh(root, "commit", "-qam", "main edits two too"); // a rebase would touch app.txt
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(300);
    writeFileSync(join(s.worktree, "app.txt"), "edited while waiting\n");
    finishEntry(other.db, ahead, "landed", "x");
    const out = await landing;
    expect(out.kind === "refused" && out.reason).toBe("dirty");
    expect(out.kind === "refused" && out.message).toContain("app.txt");
    expect(readFileSync(join(s.worktree, "app.txt"), "utf8")).toBe("edited while waiting\n");
  });

  test("BR-2039 BR-2026: a primary checkout with uncommitted changes on main keeps main still; the reason is main-dirty", async () => {
    const root = project();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Blocked by dirty main");
    writeFileSync(join(s.worktree, "new.txt"), "x\n");
    sh(s.worktree, "add", "new.txt");
    sh(s.worktree, "commit", "-qm", "x");
    writeFileSync(join(root, "app.txt"), "local edit\n");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("main-dirty");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("local edit\n");
  });

  test("BR-2016: refuses when canon check finds a broken corpus", async () => {
    const root = project();
    const s = startNew(root, "Bad ref");
    writeFileSync(join(s.worktree, "canon/changes/C-1-bad-ref.md"), "---\nid: C-1\ntitle: Bad ref\n---\n## 为什么\n\nSee D-99.\n\n## 要改什么\n\nX.\n\n## 任务\n\n- [ ] X\n");
    sh(s.worktree, "commit", "-qam", "dangling");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => f.rule)).toEqual(["ref-dangling"]);
  });

  test("BR-2111: a new decision needs a source; each source new to main is verified against its file or page", async () => {
    const decision = (options: string) =>
      `---\nid: D-1\ntitle: Pick\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n${options}\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    const pages: Record<string, string> = { "https://ok.example/a": "<html><body><p>refunds are&nbsp;allowed\n  within 30 days</p></body></html>" };
    const fetcher = async (url: string) => {
      if (url === "https://down.example/") throw new Error("getaddrinfo ENOTFOUND down.example");
      return url in pages ? { status: 200, text: pages[url]! } : { status: 404, text: "not found" };
    };
    const attempt = async (options: string, title: string) => {
      const root = project();
      const s = startNew(root, title);
      writeFileSync(join(s.worktree, "refund.txt"), "export function refund(order) {}\n");
      mkdirSync(join(s.worktree, "canon/decisions"), { recursive: true });
      writeFileSync(join(s.worktree, "canon/decisions/D-1.md"), decision(options));
      sh(s.worktree, "add", "-A");
      sh(s.worktree, "commit", "-qm", "decision");
      const out = await land(ws(s.worktree), { ...FAST, fetcher }, quiet);
      return out.kind === "refused" ? `${out.reason}: ${out.message.split("\n").slice(1).join(" ").trim()}` : out.kind;
    };
    expect(await attempt("", "No source")).toBe("source: - D-1 is new and cites no source under ## 方案 (来源：<URL or repository path> “<quote>”)");
    expect(await attempt("   - 来源：refund.txt “export function refund(order)”", "File ok")).toBe("landed");
    expect(await attempt("   - 来源：refund.txt “export function refund(item)”", "File wrong")).toBe("source: - D-1: refund.txt does not contain “export function refund(item)”");
    expect(await attempt("   - 来源：missing.txt “export function refund(order)”", "File missing")).toBe("source: - D-1: missing.txt is not a file in the repository");
    expect(await attempt("   - 来源：https://ok.example/a “refunds are allowed within 30 days”", "Page ok")).toBe("landed");
    expect(await attempt("   - 来源：https://ok.example/a “refunds are allowed within 60 days”", "Page wrong")).toBe("source: - D-1: https://ok.example/a does not contain “refunds are allowed within 60 days”");
    expect(await attempt("   - 来源：https://ok.example/gone “refunds are allowed within 30 days”", "Page 404")).toBe("source: - D-1: https://ok.example/gone answered HTTP 404");
    expect(await attempt("   - 来源：https://down.example/ “refunds are allowed within 30 days”", "Offline")).toBe(
      "source: - D-1: https://down.example/ could not be fetched (getaddrinfo ENOTFOUND down.example)",
    );
  });

  test("BR-2111: a source already on main is not fetched again, and editing an old decision needs no new source", async () => {
    const root = project();
    const s = startNew(root, "First");
    mkdirSync(join(s.worktree, "canon/decisions"), { recursive: true });
    const body = (extra: string) =>
      `---\nid: D-1\ntitle: Pick\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n   - 来源：https://ok.example/a “refunds are allowed within 30 days”\n2. B：否决${extra}。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    writeFileSync(join(s.worktree, "canon/decisions/D-1.md"), body(""));
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "decision");
    const fetched: string[] = [];
    const fetcher = async (url: string) => (fetched.push(url), { status: 200, text: "refunds are allowed within 30 days" });
    expect((await land(ws(s.worktree), { ...FAST, fetcher }, quiet)).kind).toBe("landed");
    const t = startNew(root, "Second");
    writeFileSync(join(t.worktree, "canon/decisions/D-1.md"), body("，太慢"));
    sh(t.worktree, "commit", "-qam", "reword");
    const offline = async (url: string) => (fetched.push(url), Promise.reject(new Error("offline")));
    expect((await land(ws(t.worktree), { ...FAST, fetcher: offline }, quiet)).kind).toBe("landed");
    expect(fetched).toEqual(["https://ok.example/a"]);
  });

  test("BR-2018 BR-2019: --finish closes the change, releases the claim, and clean removes only fully landed worktrees", async () => {
    const root = project();
    const done = startNew(root, "Done one");
    writeFileSync(join(done.worktree, "new.txt"), "x\n");
    sh(done.worktree, "add", "new.txt");
    sh(done.worktree, "commit", "-qm", "x");
    const out = await land(ws(done.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "landed" && out.finished).toBe(true);
    const change = readCorpus(root).corpus.docs.find((d) => d.id === "C-1");
    expect(change?.kind === "change" && change.status).toBe("done");
    expect(claims(ws(root).db)).toEqual([]);

    const open = startNew(root, "Unlanded");
    writeFileSync(join(open.worktree, "wip.txt"), "wip\n");
    sh(open.worktree, "add", "wip.txt");
    sh(open.worktree, "commit", "-qm", "wip");
    stop(ws(open.worktree), "finish wip", undefined, true);

    const r = clean(ws(root), quiet);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.removed).toEqual([done.worktree]);
    expect(existsSync(open.worktree)).toBe(true);
    expect(r.value.kept.join("\n")).toContain("not on main");
  });
});

describe("boundaries record and clean up", () => {
  const events = (root: string, kind: string) =>
    ws(root).db.db.query<{ subject: string | null; detail: string }, [string]>("SELECT subject, detail FROM events WHERE kind = ? ORDER BY id").all(kind);

  test("BR-2026: early land refusals and a refused claim are recorded with their reason", async () => {
    const root = project();
    const s = startNew(root, "Dirty");
    writeFileSync(join(s.worktree, "app.txt"), "changed\n");
    await land(ws(s.worktree), FAST, quiet);
    expect(await land(ws(root), FAST, quiet)).toMatchObject({ kind: "refused", reason: "on-main" });
    takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    const reasons = events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason);
    expect(reasons).toEqual(["dirty", "on-main"]);
    expect(events(root, "claim.refuse").map((e) => e.subject)).toEqual([s.change]);
  });

  test("BR-2026: starting a missing or closed change, and --finish without a claim, are recorded with their own reasons", async () => {
    const root = project();
    const s = startNew(root, "Closed");
    expect((await land(ws(s.worktree), { ...FAST, finish: true }, quiet)).kind).toBe("landed");
    expect(start(ws(root), { change: s.change }, quiet).ok).toBe(false);
    expect(start(ws(root), { change: "C-99" }, quiet).ok).toBe(false);
    expect(events(root, "start.refuse").map((e) => [e.subject, JSON.parse(e.detail).reason])).toEqual([
      [s.change, "not-open"],
      ["C-99", "not-found"],
    ]);
    sh(root, "worktree", "add", "-q", "-b", "loose", join(root, "..", `${root.split("/").pop()}-loose`), "main");
    const loose = join(root, "..", `${root.split("/").pop()}-loose`);
    expect(await land(ws(loose), { ...FAST, finish: true }, quiet)).toMatchObject({ kind: "refused", reason: "no-claim" });
  });

  test("BR-2043: a project without a floor cannot land anything", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "tests: []\n");
    sh(root, "commit", "-qam", "no floor");
    const s = startNew(root, "No floor");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("no-floor");
  });

  test("BR-2048: a lander that waits past its timeout gives up and records it", async () => {
    const root = project();
    const s = startNew(root, "Waiting");
    writeFileSync(join(s.worktree, "w.txt"), "w\n");
    sh(s.worktree, "add", "w.txt");
    sh(s.worktree, "commit", "-qm", "w");
    const other = ws(root);
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true); // someone else is landing right now
    const out = await land(ws(s.worktree), { finish: false, timeoutMs: 0 }, quiet);
    expect(out).toEqual({ kind: "timeout", ahead: 1 });
    expect(events(root, "land.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["timeout"]);
  });

  test("BR-2049: the heartbeat runs through the whole landing, so a slow step is not mistaken for a dead lander", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nlander_stale_minutes: 0.02\nhooks:\n  before_land: sleep 3\n");
    sh(root, "commit", "-qam", "slow before_land, 1.2 s stale time");
    const s = startNew(root, "Slow");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const other = ws(root, "agent:b");
    const landing = land(ws(s.worktree), FAST, quiet);
    await Bun.sleep(2200); // well past the 1.2 s stale time, while before_land still sleeps
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b, 1200).mine).toBe(false);
    expect((await landing).kind).toBe("landed");
    expect(tryTurn(other.db, b, 1200).mine).toBe(true);
  });

  test("BR-2031: landing from main is refused", async () => {
    const root = project();
    const out = await land(ws(root), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("on-main");
  });

  test("BR-2029: a failed setup removes the new worktree and releases the change, so a retry starts clean", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nsetup: \"test -e .ok\"\n");
    sh(root, "commit", "-qam", "setup that fails");
    const first = start(ws(root), { title: "Needs setup" }, quiet);
    expect(first.ok).toBe(false);
    expect(claims(ws(root).db)).toEqual([]);
    const wts = sh(root, "worktree", "list");
    expect(wts.split("\n").length).toBe(1);
    expect(sh(root, "branch", "--list", "change/*")).toBe("");
    expect(events(root, "start.refuse").map((e) => JSON.parse(e.detail).reason)).toEqual(["setup"]);
  });

  test("BR-2030: after_land runs in the background with the landing's commits and never changes the result", async () => {
    const root = project();
    const marker = join(root, "..", `${root.split("/").pop()}-after.txt`);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nhooks:\n  after_land: 'echo "$CANON_BASE $CANON_HEAD $CANON_CHANGE" > ${marker}; exit 7'\n`);
    sh(root, "commit", "-qam", "after_land");
    const s = startNew(root, "With hook");
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind).toBe("landed");
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(100);
    const [base, head, change] = readFileSync(marker, "utf8").trim().split(" ");
    expect(head).toBe(sh(root, "rev-parse", "main"));
    expect(base).toBe(sh(root, "rev-parse", "main~2")); // the open-change commit and x are the landed ones
    expect(change).toBe(s.change);
  });
});

describe("the claim during a landing", () => {
  test("BR-2108: a landing that waits longer than the lease keeps its claim renewed, so no one takes it meanwhile", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nclaim_lease_hours: 0.0003\n"); // about 1 s
    sh(root, "commit", "-qam", "tiny lease");
    const s = startNew(root, "Long wait");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, quiet);
    await Bun.sleep(2500); // two and a half leases
    expect(takeClaim(other.db, s.change, s.worktree, "agent:b", 1000).ok).toBe(false);
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
  });

  test("BR-2018: --finish leaves alone a claim and handoff that another session took over during the landing", async () => {
    const root = project();
    const s = startNew(root, "Taken over");
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const lines: string[] = [];
    const landing = land(ws(s.worktree), { finish: true, timeoutMs: 20_000 }, (l) => lines.push(l));
    await Bun.sleep(300);
    other.db.db.query("UPDATE claims SET holder = 'agent:b' WHERE subject = ?").run(s.change); // taken over after the lease ran out
    writeHandoff(other.db, { subject: s.change, worktree: s.worktree, actor: "agent:b", next: "mine now", note: null });
    finishEntry(other.db, ahead, "landed", "x");
    expect((await landing).kind).toBe("landed");
    expect(claims(other.db).map((c) => [c.subject, c.actor])).toEqual([[s.change, "agent:b"]]);
    expect(handoffs(other.db).map((h) => h.next)).toEqual(["mine now"]);
    expect(lines.join("\n")).toContain("claimed by another session now");
  });
});

describe("the claim names the lander while it lands", () => {
  async function deadProcess(): Promise<Proc> {
    const p = Bun.spawn(["sleep", "30"]);
    const proc = processOf(p.pid);
    if (!proc) throw new Error("no start time for a live child");
    p.kill("SIGKILL");
    await p.exited;
    return proc;
  }
  const pidOf = (root: string, change: string) => ws(root).db.db.query<{ pid: number | null }, [string]>("SELECT pid FROM claims WHERE subject = ?").get(change)?.pid;
  // reason: outside Claude Code, land keeps the session process the claim already names (BR-2100), so a test can set it.
  async function landingAsSession(session: Proc | null, body: (root: string, s: { change: string; worktree: string }, landing: Promise<unknown>) => Promise<void>) {
    const saved = process.env["CLAUDECODE"];
    delete process.env["CLAUDECODE"];
    try {
      const root = project();
      const s = startNew(root, "Session exits");
      ws(root).db.db.query("UPDATE claims SET pid = ?, pid_start = ? WHERE subject = ?").run(session?.pid ?? null, session?.start ?? null, s.change);
      const other = ws(root, "agent:b");
      const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
      expect(tryTurn(other.db, ahead).mine).toBe(true);
      const landing = land(ws(s.worktree), FAST, quiet);
      await Bun.sleep(300);
      await body(root, s, (async () => { finishEntry(other.db, ahead, "landed", "x"); return landing; })());
    } finally {
      if (saved === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = saved;
    }
  }

  test("BR-2142: a session that exits while its landing waits does not free the claim until the landing ends", async () => {
    await landingAsSession(await deadProcess(), async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBe(process.pid); // the lander, which is this test process
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(true); // the session is gone
    });
  });

  test("BR-2142: a session still running names the claim again after the landing, so it still binds", async () => {
    const session = Bun.spawn(["sleep", "30"]);
    try {
      await landingAsSession(processOf(session.pid)!, async (root, s, landing) => {
        expect(((await landing) as { kind: string }).kind).toBe("landed");
        expect(pidOf(root, s.change)).toBe(session.pid);
        expect(takeClaim(ws(root, "agent:b").db, s.change, s.worktree, "agent:b").ok).toBe(false);
      });
    } finally {
      session.kill();
    }
  });

  test("BR-2142: a lease-only claim names no process during or after the landing", async () => {
    await landingAsSession(null, async (root, s, landing) => {
      expect(pidOf(root, s.change)).toBeNull();
      expect(((await landing) as { kind: string }).kind).toBe("landed");
      expect(pidOf(root, s.change)).toBeNull();
    });
  });
});

describe("a lander killed by a signal", () => {
  const CLI = join(import.meta.dir, "../../cli/main.ts");
  const entryOf = (root: string) => ws(root).db.db.query<{ id: number; state: string; result: string | null }, []>("SELECT id, state, result FROM queue ORDER BY id DESC LIMIT 1").get();
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(50);
    expect(what()).toBe(true);
  };

  test("BR-2099: SIGTERM while the floor runs fails the entry as killed, records it, exits 143, and the next lander goes at once", async () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"sleep 30\"\ntests: []\n");
    sh(root, "commit", "-qam", "slow floor");
    const s = startNew(root, "Killed");
    const p = Bun.spawn(["bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const logs = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "canon/logs");
    await until(() => entryOf(root)?.state === "landing" && existsSync(join(logs, `land-${entryOf(root)!.id}.log`))); // the floor runs
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
    const kinds = ws(root).db.db.query<{ kind: string }, []>("SELECT kind FROM events WHERE kind LIKE 'land.%' AND kind != 'land.turn'").all().map((e) => e.kind);
    expect(kinds).toEqual(["land.killed"]); // an interruption, not a check's refusal (BR-2067)
    const other = ws(root, "agent:b");
    const b = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, b).mine).toBe(true);
  });

  test("BR-2099: a process group killed in the middle of the rebase leaves the worktree on its own commits, not mid-rebase", async () => {
    const root = project();
    const s = startNew(root, "Killed mid-rebase");
    writeFileSync(join(s.worktree, "mine.txt"), "mine\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    const before = sh(s.worktree, "rev-parse", "HEAD");
    writeFileSync(join(root, "theirs.txt"), "theirs\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "main moved"); // so the rebase has work to do
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, "..", `${root.split("/").pop()}-in-rebase`);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${marker}\nsleep 30\n`, { mode: 0o755 });
    // reason: a new process group, so the signal reaches git and the hook too, as a tool timeout's would.
    const p = Bun.spawn(["perl", "-e", "setpgrp(0,0); exec @ARGV", "bun", CLI, "work", "land"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    await until(() => existsSync(marker));
    process.kill(-p.pid, "SIGTERM");
    expect(await p.exited).toBe(143);
    expect(existsSync(join(sh(s.worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge")))).toBe(false);
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(before);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(entryOf(root)).toMatchObject({ state: "failed", result: "killed" });
  });
});

describe("queue wait", () => {
  test("BR-2122: a lander that gets its turn records land.turn with how long it waited", async () => {
    const root = project();
    const s = startNew(root, "Timed");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const turns = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.turn'").all().map((e) => JSON.parse(e.detail) as { waited_ms: number; entry: number });
    expect(turns.length).toBe(1);
    expect(turns[0]!.waited_ms).toBeGreaterThanOrEqual(0);
    expect(typeof turns[0]!.entry).toBe("number");
  });
});
