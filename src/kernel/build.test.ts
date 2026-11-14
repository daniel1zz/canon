import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDefine, canonBuild } from "./build.ts";
import { project, ws } from "../work/testkit.ts";

describe("which canon wrote an event", () => {
  test("BR-2475: canon run from source records its build as dev on every event", () => {
    expect(canonBuild()).toBe("dev");
    const root = project();
    const db = ws(root).db;
    const id = db.event("agent:a", "test.event", null, {});
    expect(db.db.query<{ c: string }, [number]>("SELECT canon AS c FROM events WHERE id = ?").get(id)!.c).toBe("dev");
  });

  test("BR-2475: a build made with the release's --define reports the commit it was built from", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "canon-build-")));
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { canonBuild } from ${JSON.stringify(join(import.meta.dir, "build.ts"))};\nconsole.log(canonBuild());\n`);
    const out = join(dir, "out.js");
    const built = Bun.spawnSync(["bun", "build", ...buildDefine("970904dfd00b37f7"), entry, "--target", "bun", "--outfile", out], { stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    const run = Bun.spawnSync(["bun", out], { stdout: "pipe", stderr: "pipe" });
    expect(run.stdout.toString().trim()).toBe("970904dfd00b37f7");
  });
});
