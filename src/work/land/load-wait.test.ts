import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { waitFor, FAST, project, sh, startNew, ws } from "../testkit.ts";
import { land } from "./land.ts";

// reason: each case lands through the real queue and waits for the machine load; a loaded machine took longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
const machine = process.env["CANON_MACHINE"];
afterEach(() => {
  if (machine === undefined) delete process.env["CANON_MACHINE"]; else process.env["CANON_MACHINE"] = machine;
  // reason: the load queue's directory is shared by the tests of this run; a release by one test would hold the next for the 60-second spacing (BR-2630)
  const queue = join(process.env["CANON_MACHINE_DIR"]!, "load-waits");
  rmSync(join(queue, "released"), { force: true });
  if (existsSync(queue)) for (const n of readdirSync(queue)) if (n.endsWith(".json")) rmSync(join(queue, n), { force: true });
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); }
});

function fixture(extra: string) {
  const root = project(); roots.push(root);
  const marker = join(root, "..", `${root.split("/").pop()}-floor-ran`);
  roots.push(marker);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "touch ${marker}"\ntests: []\nreview: none\n${extra}`);
  writeFileSync(join(root, "canon/product.md"), "# Product\n\nShared work.\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return { root, marker };
}

test("BR-2630: a landing whose turn runs the floor waits for the machine load first, says so, records load.wait and load.start for the change, and runs the floor after", async () => {
  const { root, marker } = fixture("");
  const s = startNew(root, "Code", "agent:s1");
  writeFileSync(join(s.worktree, "a.ts"), "export const a = 1;\n");
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "code");
  process.env["CANON_MACHINE"] = "normal,17,8";
  const said: string[] = [];
  const landing = land(ws(s.worktree, "agent:s1"), FAST, (l) => said.push(l));
  await waitFor("the waiting line", () => said.some((l) => l.includes("canon: waiting for the machine load")));
  expect(said.find((l) => l.includes("waiting for the machine load"))).toContain("5-minute load 17.0 on 8 CPUs (limit 16)");
  expect(existsSync(marker)).toBe(false);
  process.env["CANON_MACHINE"] = "normal,12,8";
  expect(await landing).toMatchObject({ kind: "landed" });
  expect(existsSync(marker)).toBe(true);
  const rows = ws(root, "agent:s1").db.db.query<{ kind: string; subject: string | null; detail: string }, []>("SELECT kind, subject, detail FROM events WHERE kind LIKE 'load.%' ORDER BY id").all();
  expect(rows.map((r) => [r.kind, r.subject])).toEqual([["load.wait", s.change], ["load.start", s.change]]);
  expect(JSON.parse(rows[0]!.detail)).toMatchObject({ kind: "land" });
  expect(readdirSync(join(process.env["CANON_MACHINE_DIR"]!, "load-waits")).filter((n) => n.endsWith(".json"))).toEqual([]);
});

test("BR-2630: a landing whose turn runs neither the floor nor test files does not wait for the load", async () => {
  const { root, marker } = fixture("floor_skip_paths: [canon/changes, canon/notes]\ntest_select_command: \"true\"\n");
  const s = startNew(root, "Notes", "agent:s1");
  mkdirSync(join(s.worktree, "canon/notes"), { recursive: true });
  writeFileSync(join(s.worktree, "canon/notes/N-1.md"), "---\nid: N-1\ntitle: n\n---\n\nnote\n");
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "notes");
  process.env["CANON_MACHINE"] = "normal,17,8";
  const said: string[] = [];
  expect(await land(ws(s.worktree, "agent:s1"), FAST, (l) => said.push(l))).toMatchObject({ kind: "landed" });
  expect(said.some((l) => l.includes("waiting for the machine load"))).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(ws(root, "agent:s1").db.db.query("SELECT 1 FROM events WHERE kind LIKE 'load.%'").get()).toBeNull();
});

test("BR-2630: under the limit a landing says nothing about the load", async () => {
  const { root } = fixture("");
  const s = startNew(root, "Code", "agent:s1");
  writeFileSync(join(s.worktree, "a.ts"), "export const a = 1;\n");
  sh(s.worktree, "add", "-A"); sh(s.worktree, "commit", "-qm", "code");
  process.env["CANON_MACHINE"] = "normal,3,8";
  const said: string[] = [];
  expect(await land(ws(s.worktree, "agent:s1"), FAST, (l) => said.push(l))).toMatchObject({ kind: "landed" });
  expect(said.some((l) => l.includes("waiting for the machine load"))).toBe(false);
  expect(readFileSync(join(root, "canon/config.yaml"), "utf8")).toContain("floor:");
});
