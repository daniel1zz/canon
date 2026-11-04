import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { land } from "./land.ts";
import { enqueue, finishEntry } from "./queue.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../testkit.ts";

// reason: the batch case drives two real landings behind a blocker, which takes longer than the 5 s default
const TIMED = 30_000;

const KEYS = "src/verify/config-keys.ts";
const declarations = (...keys: string[]) => `export const keys = {\n${keys.map((k) => `  ${k}: configKey({\n    key: "${k}",\n    doc: "x",\n  }),\n`).join("")}};\n`;

/** A project whose main declares `floor`, `tests` and `floor_timing` in a config-keys.ts, as canon's own repository does. */
function canonLike(config = ""): string {
  const root = project();
  mkdirSync(join(root, dirname(KEYS)), { recursive: true });
  writeFileSync(join(root, KEYS), declarations("floor", "tests", "floor_timing"));
  if (config) writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}${config}`);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "keys");
  return root;
}

const commit = (wt: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(wt, dirname(p)), { recursive: true });
    writeFileSync(join(wt, p), text);
  }
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", Object.keys(files).join(" "));
};

const withKey = (wt: string) => readFileSync(join(wt, "canon/config.yaml"), "utf8") + 'typecheck_command: "true"\n';

const lastRefusal = (root: string) => {
  const row = ws(root).db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'land.refuse' ORDER BY id DESC LIMIT 1").get();
  return row ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined;
};

describe("a config key added and used in one landing", () => {
  test("BR-2248: a landing that declares a new key and sets it in canon/config.yaml is refused with config-key; main stays", async () => {
    const root = canonLike();
    const before = sh(root, "rev-parse", "main");
    const s = startNew(root, "Key and use");
    commit(s.worktree, { [KEYS]: declarations("floor", "tests", "floor_timing", "typecheck_command"), "canon/config.yaml": withKey(s.worktree) });
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("config-key");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toContain("`typecheck_command`");
    expect(message).toContain("Land the key first without using it");
    expect(sh(root, "rev-parse", "main")).toBe(before);
    expect(lastRefusal(root)).toMatchObject({ reason: "config-key" });
  });

  test("BR-2248: declaring the key without using it lands; setting a key main already declares lands", async () => {
    const root = canonLike();
    const a = startNew(root, "Key only");
    commit(a.worktree, { [KEYS]: declarations("floor", "tests", "floor_timing", "typecheck_command") });
    expect((await land(ws(a.worktree), FAST, quiet)).kind).toBe("landed");
    const b = startNew(root, "Use it");
    commit(b.worktree, { "canon/config.yaml": withKey(b.worktree) });
    expect((await land(ws(b.worktree), FAST, quiet)).kind).toBe("landed");
  });

  test("BR-2248: the landing is refused under floor_timing before as under after", async () => {
    for (const timing of ["before", "after"]) {
      const root = canonLike(`floor_timing: ${timing}\n`);
      const s = startNew(root, `Key and use ${timing}`);
      commit(s.worktree, { [KEYS]: declarations("floor", "tests", "floor_timing", "typecheck_command"), "canon/config.yaml": withKey(s.worktree) });
      // reason: in after mode BR-2224 runs PATH's canon first; it is pointed at one that reads any config
      const path = process.env["PATH"];
      const bin = join(root, "..", `${root.split("/").pop()}-bin`);
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "canon"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env["PATH"] = `${bin}:${path}`;
      try {
        const out = await land(ws(s.worktree), FAST, quiet);
        expect(`${timing} ${out.kind === "refused" && out.reason}`).toBe(`${timing} config-key`);
      } finally {
        process.env["PATH"] = path;
      }
    }
  });

  test("BR-2248: a project whose main declares no config key is not checked", async () => {
    const root = project();
    const s = startNew(root, "Plain project");
    commit(s.worktree, { [KEYS]: declarations("typecheck_command"), "canon/config.yaml": withKey(s.worktree) });
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
  });

  test("BR-2248: in a batch a member is compared with main, not with the member before it, so the batch falls back and both land alone", async () => {
    const root = canonLike("land_batch_max: 3\n");
    const a = startNew(root, "Adds the key");
    commit(a.worktree, { [KEYS]: declarations("floor", "tests", "floor_timing", "typecheck_command") });
    const b = startNew(root, "Uses the key");
    commit(b.worktree, { "canon/config.yaml": withKey(b.worktree) });
    const other = ws(root, "agent:b");
    const blocker = enqueue(other.db, "/elsewhere", "C-99", "agent:b");
    const said: string[][] = [[], []];
    const runs: ReturnType<typeof land>[] = [];
    for (const [i, wt] of [a.worktree, b.worktree].entries()) {
      runs.push(land(ws(wt), FAST, (m) => said[i]!.push(m)));
      for (let n = 0; n < 200 && !other.db.db.query("SELECT 1 FROM queue WHERE worktree = ? AND state = 'waiting'").get(wt); n++) await Bun.sleep(10);
    }
    finishEntry(other.db, blocker, "landed", "x");
    const out = await Promise.all(runs);
    expect(said[0]!.some((m) => m.includes(`${b.change} was refused in the batch (config-key)`))).toBe(true);
    expect(out.map((o) => o.kind)).toEqual(["landed", "landed"]);
    expect(sh(root, "show", "main:canon/config.yaml")).toContain("typecheck_command");
  }, TIMED);
});
