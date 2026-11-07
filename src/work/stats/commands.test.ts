import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordDb } from "../db.ts";
import { project, sh } from "../testkit.ts";

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A project with a code root and a shared directory, and one search recorded in its coordination database. */
function withSharedAndSearch(): string {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\ncode_root: src\nshared: [src/kernel]\n");
  mkdirSync(join(root, "src/kernel"), { recursive: true });
  writeFileSync(join(root, "src/kernel/a.ts"), "a\n");
  writeFileSync(join(root, "src/b.ts"), "b\nb\nb\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "code");
  const db = CoordDb.open(join(root, ".git/canon/state.db"));
  if (!db.ok) throw new Error(db.error.message);
  db.value.event("agent:test", "search", null, { query: "q", results: 0, full: 0 });
  db.value.close();
  return root;
}

describe("canon stats output order", () => {
  test("BR-2121 BR-2135: the shared code line is the last line, after the search line (issue #70)", () => {
    const r = canon(withSharedAndSearch(), "stats");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n").filter((l) => l !== "");
    expect(lines.at(-1)).toBe("shared code: 1 of 4 lines under src (25.0%): above 20%; move code that serves one domain into that domain's directory");
    expect(lines.at(-2)).toBe("searches: 1, no result: 1 (100.0%), no full match: 1 (100.0%)");
  });
});

/** Spawns `canon events --follow ...`, calls `act` every 300 ms and collects stdout until `until(out)` holds or the timeout passes, sends SIGTERM and returns what was printed and the exit code. */
async function follow(cwd: string, args: string[], act: () => void, until: (out: string) => boolean, timeoutMs = 15000) {
  const p = Bun.spawn([process.execPath, MAIN, "events", "--follow", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  let out = "";
  const decoder = new TextDecoder();
  // One reader loop appends to `out`, so no chunk is lost to an abandoned read.
  const pump = (async () => {
    for await (const chunk of p.stdout) out += decoder.decode(chunk);
  })();
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs + 5000);
  try {
    // reason: the command takes its start point when it starts, which is not observable; writing again until the output shows
    // an event makes the test wait on a condition, not on a fixed delay.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !until(out)) {
      act();
      await Bun.sleep(300);
    }
  } finally {
    p.kill("SIGTERM");
  }
  const code = await p.exited;
  await pump;
  clearTimeout(timer);
  return { out, code };
}

describe("canon events --follow", () => {
  function write(root: string, kind: string, subject: string) {
    const db = CoordDb.open(join(root, ".git/canon/state.db"));
    if (!db.ok) throw new Error(db.error.message);
    db.value.event("agent:test", kind, subject, { n: 1 });
    db.value.close();
  }

  test("BR-2357 BR-2156: a new event after start prints as a text line, the old ones do not, SIGTERM exits 0", async () => {
    const root = withSharedAndSearch();
    const r = await follow(root, [], () => write(root, "handoff.write", "C-1"), (o) => o.includes("handoff.write"));
    const lines = r.out.trim().split("\n");
    expect(lines.every((l) => /^#\d+ \S+ agent:test - handoff\.write C-1 \{"n":1\}$/.test(l))).toBe(true);
    expect(r.out).not.toContain(" search ");
    expect(r.code).toBe(0);
  });

  test("BR-2357: --json --follow prints one object per line and --kind filters new events", async () => {
    const root = withSharedAndSearch();
    const r = await follow(
      root,
      ["--json", "--kind", "land.ok"],
      () => { write(root, "land.refuse", "C-1"); write(root, "land.ok", "C-2"); },
      (o) => o.includes("land.ok"),
    );
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ kind: "land.ok", subject: "C-2", detail: { n: 1 } });
    expect(r.code).toBe(0);
  });

  test("BR-2357: --since prints the existing events after it first", async () => {
    const root = withSharedAndSearch();
    const r = await follow(root, ["--since", "0", "--kind", "search"], () => {}, (o) => o.includes(" search "));
    expect(r.out).toMatch(/ search - \{"query":"q"/);
    expect(r.code).toBe(0);
  });
});
