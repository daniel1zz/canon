import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims } from "../claims/claims.ts";
import { enqueue, finishEntry, tryTurn } from "./queue/queue.ts";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { clean, stop } from "../session/session.ts";
import { land } from "./land.ts";
import { LAND_MARKER } from "./finish/finish.ts";
import { ensureGuard } from "../../install/githook.ts";
import { FAST, project, quiet, sh, startNew, waitFor, ws } from "../testkit.ts";

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
    writeFileSync(join(root, "app.txt"), "one\ntwo\nthree\nfour\n");
    sh(root, "commit", "-qam", "main edits app.txt too"); // a rebase would touch app.txt, without a conflict (BR-2153)
    const other = ws(root, "agent:b");
    const ahead = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    expect(tryTurn(other.db, ahead).mine).toBe(true);
    const landing = land(ws(s.worktree), FAST, quiet);
    await waitFor("the landing to wait in the queue", () => other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(s.worktree) !== null);
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

  describe("BR-2111: a new decision needs a source; each source new to main is verified against its file or page", () => {
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
      if (out.kind !== "refused") return out.kind;
      // reason: a source path that is no file, or a file without its quote, is reported by canon check before the source step (BR-2110, BR-2252)
      if (out.findings) return `${out.reason}: ${out.findings.map((f) => `${f.rule} ${f.message}`).join(" ")}`;
      return `${out.reason}: ${out.message.split("\n").slice(1).join(" ").trim()}`;
    };
    // reason: one landing per test, not eight in one, so each case has the whole timeout to itself under load (C-111).
    const cases: [string, string, string][] = [
      ["No source", "", "source: - D-1 is new and cites no source under ## 方案 (来源：<URL or repository path> “<quote>”)"],
      ["File ok", "   - 来源：refund.txt “export function refund(order)”", "landed"],
      ["File wrong", "   - 来源：refund.txt “export function refund(item)”", "check: source-quote-missing D-1: refund.txt does not contain “export function refund(item)” (- 来源：refund.txt “export function refund(item)”)"],
      ["File missing", "   - 来源：missing.txt “export function refund(order)”", "check: source-malformed D-1: - 来源：missing.txt “export function refund(order)” (missing.txt is not a file in the repository)"],
      ["Page ok", "   - 来源：https://ok.example/a “refunds are allowed within 30 days”", "landed"],
      ["Page wrong", "   - 来源：https://ok.example/a “refunds are allowed within 60 days”", "source: - D-1: https://ok.example/a does not contain “refunds are allowed within 60 days”"],
      ["Page 404", "   - 来源：https://ok.example/gone “refunds are allowed within 30 days”", "source: - D-1: https://ok.example/gone answered HTTP 404"],
      ["Offline", "   - 来源：https://down.example/ “refunds are allowed within 30 days”", "source: - D-1: https://down.example/ could not be fetched (getaddrinfo ENOTFOUND down.example)"],
    ];
    for (const [title, options, expected] of cases) {
      test(`BR-2111: ${title}`, async () => {
        expect(await attempt(options, title)).toBe(expected);
      });
    }
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
