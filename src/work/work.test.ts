import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claims, enqueue, takeClaim, tryTurn } from "../coord/state.ts";
import { readCorpus } from "../knowledge/read.ts";
import { clean, land, start, stop } from "./work.ts";

import { FAST, project, quiet, sh, startNew, ws } from "./testkit.ts";

describe("work start", () => {
  test("BR-2012: a new change gets its own worktree, branch, committed change file and claim", () => {
    const root = project();
    const s = startNew(root, "Refund window");
    expect(s.change).toBe("C-1");
    expect(existsSync(join(s.worktree, "canon/changes/C-1-refund-window.md"))).toBe(true);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    expect(claims(ws(root).db).map((c) => [c.subject, c.holder])).toEqual([["C-1", s.worktree]]);
  });

  test("BR-2038: an open change on main is started even when the primary checkout has another branch out", async () => {
    const root = project();
    const s = startNew(root, "Planned");
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    sh(root, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "app.txt"), "diverged\n");
    sh(root, "rm", "-rq", "canon/changes");
    sh(root, "commit", "-qam", "elsewhere: no changes dir");
    sh(root, "worktree", "remove", s.worktree);
    const again = start(ws(root, "agent:b"), { change: s.change }, quiet);
    expect(again.ok).toBe(true);
    if (again.ok) expect(readFileSync(join(again.value.worktree, "app.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("BR-2011: a change claimed by another worktree is refused while its lease is live", () => {
    const root = project();
    const s = startNew(root, "A");
    const other = takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b");
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.error.code).toBe("conflict");
      expect(other.error.message).toContain(s.worktree); // names the holder
    }
  });

  test("BR-2011: work commands in the holding worktree renew the lease, so a long session is never taken over", async () => {
    const root = project();
    const s = startNew(root, "Long");
    const db = ws(root).db;
    const expire = () => db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(Date.now() - 3600_000).toISOString(), s.change);
    const expiry = () => new Date(claims(db)[0]!.expires_at).getTime();
    expire();
    expect(stop(ws(s.worktree), "keep going", undefined, false).ok).toBe(true);
    expect(expiry()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expire();
    writeFileSync(join(s.worktree, "x.txt"), "x\n");
    sh(s.worktree, "add", "x.txt");
    sh(s.worktree, "commit", "-qm", "x");
    await land(ws(s.worktree), FAST, quiet);
    expect(expiry()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expect(takeClaim(ws(root, "agent:b").db, s.change, "/elsewhere", "agent:b").ok).toBe(false);
  });

  test("BR-2011: claim_lease_hours sets the lease", () => {
    const root = project();
    writeFileSync(join(root, "canon/config.yaml"), "floor: \"true\"\ntests: []\nclaim_lease_hours: 1\n");
    sh(root, "commit", "-qam", "short lease");
    const s = startNew(root, "Short");
    const left = new Date(claims(ws(root).db)[0]!.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    expect(s.change).toBe("C-1");
  });

  test("BR-2047: worktrees go where `worktrees` says, relative to the primary checkout; clean only looks there", () => {
    const root = project();
    const old = startNew(root, "Old place");
    stop(ws(old.worktree), "x", undefined, true);
    writeFileSync(join(root, "canon/config.yaml"), `floor: "true"\ntests: []\nworktrees: ../${root.split("/").pop()}-wt\n`);
    sh(root, "commit", "-qam", "move worktrees");
    const s = startNew(root, "New place");
    expect(s.worktree).toBe(join(realpathSync(root), "..", `${root.split("/").pop()}-wt`, s.change));
    expect(existsSync(s.worktree)).toBe(true);
    const r = clean(ws(root), quiet);
    expect(r.ok && [...r.value.removed, ...r.value.kept].join("\n")).not.toContain(old.worktree);
    expect(existsSync(old.worktree)).toBe(true);
  });

  test("BR-2011: once the lease has expired another worktree can take the change over", () => {
    const root = project();
    const s = startNew(root, "A");
    const db = ws(root, "agent:b").db;
    db.db.query("UPDATE claims SET expires_at = ? WHERE subject = ?").run(new Date(Date.now() - 13 * 3600_000).toISOString(), s.change);
    expect(takeClaim(db, s.change, "/elsewhere", "agent:b").ok).toBe(true);
    expect(claims(db).map((c) => c.holder)).toEqual(["/elsewhere"]);
  });
});

describe("rule review at land", () => {
  function reviewedProject(verdict: "ok" | "block") {
    const root = project();
    const promptFile = join(root, "..", `${root.split("/").pop()}-prompt.txt`);
    writeFileSync(
      join(root, "canon/config.yaml"),
      `floor: "true"\ntests: []\nreview: 'cat > ${promptFile}; echo ''{"verdict":"${verdict}","findings":["${["BR", 1].join("-")} is vague"]}'''\n`,
    );
    mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n");
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
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n");
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
    writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n");
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
    writeFileSync(join(s.worktree, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\nRules here are optional.\n");
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
    writeFileSync(join(s.worktree, "canon/changes/C-1-bad-ref.md"), "---\nid: C-1\ntitle: Bad ref\n---\nSee D-99.\n");
    sh(s.worktree, "commit", "-qam", "dangling");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("check");
    expect(out.kind === "refused" && out.findings?.map((f) => f.rule)).toEqual(["ref-dangling"]);
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

describe("same-file overlap", () => {
  const commitFile = (wt: string, file: string, text: string) => {
    writeFileSync(join(wt, file), text);
    sh(wt, "add", file);
    sh(wt, "commit", "-qm", file);
  };
  const notices = (root: string) =>
    ws(root).db.db.query<{ subject: string; detail: string }, []>("SELECT subject, detail FROM events WHERE kind = 'overlap.notice' ORDER BY id").all().map((e) => ({ subject: e.subject, ...JSON.parse(e.detail) }));

  test("BR-2062: landing a change that shares a committed file with another change prints and records a notice, and still lands", async () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    const c = startNew(root, "C");
    commitFile(a.worktree, "shared.txt", "a\n");
    commitFile(b.worktree, "shared.txt", "b\n");
    commitFile(c.worktree, "other.txt", "c\n");
    writeFileSync(join(c.worktree, "shared.txt"), "uncommitted\n");
    const lines: string[] = [];
    const out = await land(ws(a.worktree), FAST, (l) => lines.push(l));
    expect(out.kind).toBe("landed");
    expect(lines.filter((l) => l.startsWith("overlap:"))).toEqual([`overlap: ${b.change} also changes shared.txt; whoever lands second resolves the conflict`]);
    expect(notices(root)).toEqual([{ subject: a.change, at: "land", with: b.change, files: ["shared.txt"] }]);
  });

  test("BR-2062: a landing refused before the queue (uncommitted work) prints no overlap notice", async () => {
    const root = project();
    const a = startNew(root, "A");
    const b = startNew(root, "B");
    commitFile(a.worktree, "shared.txt", "a\n");
    commitFile(b.worktree, "shared.txt", "b\n");
    writeFileSync(join(a.worktree, "dirty.txt"), "x\n");
    const lines: string[] = [];
    expect((await land(ws(a.worktree), FAST, (l) => lines.push(l))).kind).toBe("refused");
    expect(lines.some((l) => l.startsWith("overlap:"))).toBe(false);
    expect(notices(root)).toEqual([]);
  });

  test("BR-2062: restarting a change whose branch already overlaps another prints the notice; a fresh change does not", () => {
    const root = project();
    mkdirSync(join(root, "canon/changes"), { recursive: true });
    writeFileSync(join(root, "canon/changes/C-1.md"), "---\nid: C-1\ntitle: Planned\nstatus: open\n---\n## 为什么\n\nPlanned.\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "planned change");
    const a = start(ws(root), { change: "C-1" }, quiet);
    if (!a.ok) throw new Error(a.error.message);
    const fresh: string[] = [];
    const b = start(ws(root), { title: "B" }, (l) => fresh.push(l));
    if (!b.ok) throw new Error(b.error.message);
    expect(fresh.some((l) => l.startsWith("overlap:"))).toBe(false);
    commitFile(a.value.worktree, "shared.txt", "a\n");
    commitFile(b.value.worktree, "shared.txt", "b\n");
    const lines: string[] = [];
    expect(start(ws(root), { change: "C-1" }, (l) => lines.push(l)).ok).toBe(true);
    expect(lines.filter((l) => l.startsWith("overlap:"))).toEqual([`overlap: ${b.value.change} also changes shared.txt; whoever lands second resolves the conflict`]);
    expect(notices(root)).toEqual([{ subject: "C-1", at: "start", with: b.value.change, files: ["shared.txt"] }]);
  });
});
