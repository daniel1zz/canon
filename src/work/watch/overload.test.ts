import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedLoop, project, quiet, sh, waitFor, ws } from "../testkit.ts";
import { redMain } from "./redmain.ts";
import { watch } from "./watch.ts";

// reason: each case runs real floors in a temporary worktree behind the machine's load gate, which takes seconds under load
setDefaultTimeout(90_000);

const roots: string[] = [];
const machine = process.env["CANON_MACHINE"];
afterEach(() => {
  if (machine === undefined) delete process.env["CANON_MACHINE"]; else process.env["CANON_MACHINE"] = machine;
  // reason: the load queue's directory is shared by the tests of this process; a release by one test would hold the next for the 60-second spacing (BR-2630)
  const queue = join(process.env["CANON_MACHINE_DIR"]!, "load-waits");
  rmSync(join(queue, "released"), { force: true });
  if (existsSync(queue)) for (const n of readdirSync(queue)) if (n.endsWith(".json")) rmSync(join(queue, n), { force: true });
  for (const root of roots.splice(0)) for (const p of [root, `${root}-floor`]) rmSync(p, { recursive: true, force: true });
});

/** A watched project whose floor appends the tested commit to `runs`, waits while `hold` exists, then fails when the tree has FAIL. */
function watched() {
  const root = project();
  roots.push(root);
  const dir = `${root}-floor`;
  mkdirSync(dir, { recursive: true });
  const runs = join(dir, "runs");
  const hold = join(dir, "hold");
  writeFileSync(join(dir, "floor.sh"), `git rev-parse HEAD >> ${runs}\n${boundedLoop(`[ -e ${hold} ]`, 0.1)}\ntest ! -e FAIL\n`);
  writeFileSync(join(root, "canon/config.yaml"), `floor: "sh ${join(dir, "floor.sh")}"\ntests: []\nfloor_timing: after\nfloor_quiet_minutes: 0\n`);
  sh(root, "commit", "-qam", "config");
  const tested = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : []);
  return { root, hold, tested };
}

const commit = (root: string, path: string) => {
  writeFileSync(join(root, path), "x\n");
  sh(root, "add", path);
  sh(root, "commit", "-qm", `${path} written`);
  return sh(root, "rev-parse", "HEAD");
};

const events = (root: string, ...kinds: string[]) =>
  ws(root).db.db.query<{ kind: string; subject: string | null; detail: string }, []>(`SELECT kind, subject, detail FROM events WHERE kind IN (${kinds.map((k) => `'${k}'`).join(", ")}) ORDER BY id`).all().map((r) => {
    // reason: load.wait and load.start carry the step's kind in their detail, kept apart from the event's kind
    const { kind: step, ...detail } = JSON.parse(r.detail) as Record<string, unknown>;
    return { ...detail, kind: r.kind, subject: r.subject, ...(step === undefined ? {} : { step }) } as Record<string, unknown>;
  });

const logOf = (root: string, sha: string) => join(ws(root).db.db.filename, "..", "logs", `watch-${sha.slice(0, 12)}.log`);

test("BR-2630: the background floor watch waits for the machine load before its floor, writes the waiting line to its log, records load.wait and load.start for main, and runs the floor once the load falls", async () => {
  const { root, tested } = watched();
  const a = commit(root, "a.txt");
  process.env["CANON_MACHINE"] = "normal,17,8";
  const run = watch(ws(root), quiet);
  await waitFor("the background floor to queue for the load", () => events(root, "load.wait").length > 0);
  expect(events(root, "load.wait")).toEqual([expect.objectContaining({ subject: null, step: "floor", limit: 16, load: 17 })]);
  expect(tested()).toEqual([]);
  expect(readFileSync(logOf(root, a), "utf8")).toContain("canon: waiting for the machine load: 5-minute load 17.0 on 8 CPUs (limit 16)");
  process.env["CANON_MACHINE"] = "normal,3,8";
  const r = await run;
  expect(r.ok && r.value.tested.map((t) => [t.sha, t.passed])).toEqual([[a, true]]);
  expect(tested()).toEqual([a]);
  expect(events(root, "load.wait", "load.start").map((e) => [e.kind, e.subject])).toEqual([["load.wait", null], ["load.start", null]]);
});

test("BR-2665: the background floor waits by heavy_max_load_per_cpu, not by delegate_max_load_per_cpu: 1000 for delegating leaves the load gate at 2 per CPU, and 3 for heavy steps lets load 17 on 8 CPUs through", async () => {
  const { root, tested } = watched();
  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}delegate_max_load_per_cpu: 1000\n`);
  sh(root, "commit", "-qam", "delegating by memory only");
  const a = commit(root, "a.txt");
  process.env["CANON_MACHINE"] = "normal,17,8";
  const run = watch(ws(root), quiet);
  await waitFor("the background floor to queue for the load", () => events(root, "load.wait").length > 0);
  expect(events(root, "load.wait")[0]).toMatchObject({ limit: 16 });
  expect(tested()).toEqual([]);
  process.env["CANON_MACHINE"] = "normal,3,8";
  await run;
  expect(tested()).toEqual([a]);
  // reason: the release just recorded would hold the next step for the 60-second spacing (BR-2630)
  rmSync(join(process.env["CANON_MACHINE_DIR"]!, "load-waits", "released"), { force: true });

  writeFileSync(join(root, "canon/config.yaml"), `${readFileSync(join(root, "canon/config.yaml"), "utf8")}heavy_max_load_per_cpu: 3\n`);
  sh(root, "commit", "-qam", "heavy steps up to 3 per CPU");
  const b = commit(root, "b.txt");
  process.env["CANON_MACHINE"] = "normal,17,8";
  await watch(ws(root), quiet);
  expect(tested()).toEqual([a, b]);
  expect(events(root, "load.wait")).toHaveLength(1);
});

test("BR-2666 BR-2220: a background floor that fails while the 5-minute load is at the heavy-step limit records floor.overload, no floor.fail and no failing main, reverts nothing, and tests main again behind the load gate once the load falls", async () => {
  const { root, hold, tested } = watched();
  const a = commit(root, "FAIL");
  writeFileSync(hold, "");
  process.env["CANON_MACHINE"] = "normal,3,8";
  const said: string[] = [];
  const run = watch(ws(root), (l) => said.push(l));
  await waitFor("the floor to start", () => tested().length === 1);
  // The load climbs while the floor runs, as other work starts after it passed the gate (#317).
  process.env["CANON_MACHINE"] = "normal,16,8";
  rmSync(hold);
  await waitFor("the overload failure to be recorded", () => events(root, "floor.overload").length === 1);
  expect(events(root, "floor.overload")[0]).toMatchObject({ sha: a, exit: 1, load: 16, cpus: 8, limit: 16, attempt: 1 });
  expect(events(root, "floor.fail", "revert.skip", "land.revert")).toEqual([]);
  expect(redMain(ws(root).db)).toBeUndefined();
  expect(said.join("\n")).toContain(`floor watch: main ${a.slice(0, 9)} failed (floor exited 1) while the 5-minute load was 16.0 on 8 CPUs (limit 16): overload failure 1 of 3 in a row, not recorded as a failing main; tested again once the load falls (BR-2666)`);
  // The same commit is tested again only once the load is under the limit.
  await waitFor("the retest to queue for the load", () => events(root, "load.wait").length === 1);
  expect(tested()).toEqual([a]);
  process.env["CANON_MACHINE"] = "normal,15.9,8";
  const r = await run;
  expect(tested()).toEqual([a, a]);
  // Under the limit the same failure is main's: recorded, and main is failing.
  expect(r.ok && r.value.tested.at(-1)).toMatchObject({ sha: a, passed: false });
  expect(events(root, "floor.fail").map((e) => e["sha"])).toEqual([a]);
  expect(events(root, "floor.fail")[0]!["overload"]).toBeUndefined();
  expect(redMain(ws(root).db)?.sha).toBe(a);
});

test("BR-2666: the third overload failure in a row counts as failing: floor.fail with why naming the overload and the count, a failing main, and the log saying so", async () => {
  const { root, hold, tested } = watched();
  const a = commit(root, "FAIL");
  const db = ws(root).db;
  for (const attempt of [1, 2]) db.event("agent:a", "floor.overload", null, { sha: a, log: "x", exit: 1, why: "floor exited 1", load: 20, cpus: 8, limit: 16, attempt });
  writeFileSync(hold, "");
  process.env["CANON_MACHINE"] = "normal,3,8";
  const run = watch(ws(root), quiet);
  await waitFor("the floor to start", () => tested().length === 1);
  process.env["CANON_MACHINE"] = "normal,30,8";
  rmSync(hold);
  await run;
  expect(events(root, "floor.overload")).toHaveLength(2);
  const fail = events(root, "floor.fail");
  expect(fail.map((e) => e["sha"])).toEqual([a]);
  expect(fail[0]!["why"]).toBe("floor exited 1 while the 5-minute load was 30.0 on 8 CPUs (limit 16), overload failure 3 of 3 in a row, so it counts as failing; the machine may be too loaded for this floor (BR-2666)");
  expect(fail[0]!["overload"]).toEqual({ load: 30, cpus: 8, limit: 16, attempt: 3 });
  expect(redMain(ws(root).db)?.sha).toBe(a);
  expect(readFileSync(logOf(root, a), "utf8")).toContain("overload failure 3 of 3 in a row, so it counts as failing");
});

test("BR-2666: a pass between overload failures starts the count again: after overload, pass, overload the next one is failure 2 of 3, not 3", async () => {
  const { root, hold, tested } = watched();
  const db = ws(root).db;
  db.event("agent:a", "floor.overload", null, { sha: "0", attempt: 1 });
  db.event("agent:a", "floor.pass", null, { sha: "1" });
  db.event("agent:a", "floor.overload", null, { sha: "2", attempt: 1 });
  const a = commit(root, "FAIL");
  writeFileSync(hold, "");
  process.env["CANON_MACHINE"] = "normal,3,8";
  const run = watch(ws(root), quiet);
  await waitFor("the floor to start", () => tested().length === 1);
  process.env["CANON_MACHINE"] = "normal,20,8";
  rmSync(hold);
  await waitFor("the overload failure to be recorded", () => events(root, "floor.overload").length === 3);
  expect(events(root, "floor.overload")[2]).toMatchObject({ sha: a, attempt: 2 });
  expect(events(root, "floor.fail")).toEqual([]);
  process.env["CANON_MACHINE"] = "normal,3,8";
  await run;
});

test("BR-2666: a floor that fails under the limit is main's failure at once, and one whose load cannot be read is too", async () => {
  const { root } = watched();
  const a = commit(root, "FAIL");
  process.env["CANON_MACHINE"] = "normal,15.9,8";
  await watch(ws(root), quiet);
  expect(events(root, "floor.overload")).toEqual([]);
  expect(events(root, "floor.fail").map((e) => e["sha"])).toEqual([a]);

  const b = commit(root, "b.txt");
  process.env["CANON_MACHINE"] = "normal,none,8";
  await watch(ws(root), quiet);
  expect(events(root, "floor.overload")).toEqual([]);
  expect(events(root, "floor.fail").map((e) => e["sha"])).toEqual([a, b]);
});
