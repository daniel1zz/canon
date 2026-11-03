import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCorpus } from "../../knowledge/documents/read.ts";
import { keptPlaces } from "./queue.ts";
import { land } from "./land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: drives a spawned `canon work land` (C-111).
const TIMED = 30_000;
const CLI = join(import.meta.dir, "../../cli/main.ts");

const reasons = (root: string) => ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse' ORDER BY id").all().map((e) => JSON.parse(e.detail).reason as string);

describe("a git or file operation that fails during a landing", () => {
  test("BR-2193: a close commit that git refuses exits 4 as environment, and leaves the change open and the worktree clean", async () => {
    const root = project();
    const s = startNew(root, "Hook refuses");
    const head = sh(s.worktree, "rev-parse", "HEAD");
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'pre-commit says no' >&2\nexit 1\n", { mode: 0o755 });
    const p = Bun.spawn(["bun", CLI, "work", "land", "--finish"], { cwd: s.worktree, stdout: "pipe", stderr: "pipe", env: { ...process.env, CANON_ACTOR: "agent:a" } });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(4);
    expect(err).toContain("land refused (environment)");
    expect(sh(s.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(s.worktree, "status", "--porcelain")).toBe("");
    const change = readCorpus(s.worktree).corpus.docs.find((d) => d.id === s.change);
    expect(change?.kind === "change" && change.status).toBe("open");
    expect(reasons(root)).toEqual(["environment"]);
    expect(ws(root).db.db.query("SELECT 1 FROM queue").all()).toEqual([]);
  }, TIMED);

  test("BR-2193: a change file edited while the failing close commit runs keeps that edit (issue #80)", async () => {
    const root = project();
    const s = startNew(root, "Edited meanwhile");
    const file = sh(s.worktree, "ls-files", "canon/changes").split("\n").find((f) => f.includes(s.change))!;
    const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho 'edit saved meanwhile' >> ${file}\nexit 1\n`, { mode: 0o755 });
    const out = await land(ws(s.worktree), { ...FAST, finish: true }, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    expect(out.kind === "refused" && out.message).toContain("left as it is");
    expect(readFileSync(join(s.worktree, file), "utf8")).toContain("edit saved meanwhile");
  }, TIMED);

  test("BR-2193 BR-2067: a rebase that fails without a conflicted file is environment, keeps no place, and counts as no check", async () => {
    const root = project();
    const s = startNew(root, "Locked index");
    writeFileSync(join(s.worktree, "mine.txt"), "mine\n");
    sh(s.worktree, "add", "mine.txt");
    sh(s.worktree, "commit", "-qm", "mine");
    writeFileSync(join(root, "theirs.txt"), "theirs\n");
    sh(root, "add", "theirs.txt");
    sh(root, "commit", "-qm", "main moved"); // so the rebase has work to do
    writeFileSync(sh(s.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"), "");
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    expect(out.kind === "refused" && out.message).toContain("index.lock");
    expect(out.kind === "refused" && out.message).not.toContain("keeps its place");
    expect(keptPlaces(ws(root).db)).toEqual([]);
    expect(reasons(root)).toEqual(["environment"]);
    const { computeStats } = await import("../stats/stats.ts");
    const stats = computeStats(ws(root).db, {}, "2026-11-03");
    for (const c of ["check", "conflict", "main-moved"]) expect(stats.find((x) => x.check === c)!.refused).toBe(0);
  }, TIMED);
});
