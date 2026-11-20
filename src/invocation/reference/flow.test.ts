import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CONFIG_KEYS } from "../config.ts";
import { FLOW } from "../flow.ts";
import { project, sh } from "../../work/testkit.ts";
import type { FlowKeyView, FlowStepView, FlowView } from "./flow-view.ts";

// reason: these tests spawn the canon CLI in real repositories, which is what they test.
setDefaultTimeout(60_000);

const MAIN = join(import.meta.dir, "../main.ts");

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function withConfig(yaml: string) {
  const root = project();
  writeFileSync(join(root, "canon/config.yaml"), yaml);
  sh(root, "commit", "-q", "--allow-empty", "-am", "config");
  return root;
}

const BASE = "floor: test ! -e FAIL\ntests: []\n";

function flowOf(yaml: string): FlowView {
  const r = canon(withConfig(yaml), "config", "--flow", "--json");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as FlowView;
}

const step = (f: FlowView, id: string): FlowStepView => {
  const s = f.stages.flatMap((st) => st.steps).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const keyIn = (s: FlowStepView, key: string): FlowKeyView => {
  const k = s.keys.find((x) => x.key === key);
  if (!k) throw new Error(`no key ${key} under ${s.id}`);
  return k;
};

describe("canon config --flow", () => {
  test("BR-2540: stages come in the flow's order, and every key canon knows is under at least one step", () => {
    const f = flowOf(BASE);
    expect(f.stages.map((s) => s.id)).toEqual(["session", "start", "test", "preview", "land", "after", "stop", "accept"]);
    const listed = new Set(f.stages.flatMap((s) => s.steps.flatMap((st) => st.keys.map((k) => k.key.split(".")[0]))));
    for (const [, k] of CONFIG_KEYS) expect(listed.has(k.key)).toBe(true);
    // review configures both the preview and the review after landing
    expect(keyIn(step(f, "preview.review"), "review")).toBeDefined();
    expect(keyIn(step(f, "after.review"), "review")).toBeDefined();
  });

  test("BR-2540: every step a key names exists in the flow", () => {
    const ids = new Set<string>(FLOW.flatMap((s) => s.steps.map((st) => st.id)));
    for (const [, k] of CONFIG_KEYS) for (const s of k.flow.steps) expect(ids.has(s)).toBe(true);
  });

  test("BR-2540: no remote → pushing is idle and names remote; remote: origin → it runs", () => {
    const off = step(flowOf(BASE), "after.push");
    expect(off.runs).toBe(false);
    expect(off.idle).toContain("remote");
    expect(step(flowOf(`${BASE}remote: origin\n`), "after.push").runs).toBe(true);
  });

  test("BR-2540: floor_timing moves the floor between landing and the background", () => {
    const before = flowOf(BASE);
    expect(step(before, "land.floor").runs).toBe(true);
    expect(step(before, "after.floor").runs).toBe(false);
    expect(step(before, "after.floor").idle).toContain("floor_timing");
    const after = flowOf(`${BASE}floor_timing: after\n`);
    expect(step(after, "land.floor").runs).toBe(false);
    expect(step(after, "after.floor").runs).toBe(true);
  });

  test("BR-2540: review: none makes both rule review steps idle, naming review", () => {
    const f = flowOf(`${BASE}review: none\n`);
    for (const id of ["preview.review", "after.review"]) {
      expect(step(f, id).runs).toBe(false);
      expect(step(f, id).idle).toContain("review");
    }
  });

  test("BR-2540: a hook step lists only its own event and runs only when that event has a command", () => {
    const root = withConfig(`${BASE}hooks:\n  before_land: ./check.sh\n`);
    writeFileSync(join(root, "check.sh"), "#!/bin/sh\n");
    sh(root, "add", "check.sh");
    sh(root, "commit", "-qm", "hook script");
    const r = canon(root, "config", "--flow", "--json");
    expect(r.code).toBe(0);
    const f = JSON.parse(r.out) as FlowView;
    const before = step(f, "land.before_land");
    expect(before.runs).toBe(true);
    expect(before.keys.map((k) => k.key)).toEqual(["hooks.before_land"]);
    expect(keyIn(before, "hooks.before_land").value).toBe("./check.sh");
    expect(step(f, "after.after_land").runs).toBe(false);
    const text = canon(root, "config", "--flow");
    expect(text.out.split("\n")).toContain(`    hooks.before_land = "./check.sh"  可选（这个事件不配命令）`);
  });

  test("BR-2540: only the listed values make a step idle; every other step runs", () => {
    const idle = (f: FlowView): string[] => f.stages.flatMap((s) => s.steps).filter((s) => !s.runs).map((s): string => s.id).sort();
    const hookSteps = ["start.after_start", "land.before_land", "after.after_land", "after.code_review", "after.after_green", "stop.after_stop"];
    // BASE leaves the required test_command and links_since unset, so the steps they configure are idle too
    expect(idle(flowOf(BASE))).toEqual(
      ["preview.review", "after.review", "after.push", "preview.related", "test.typecheck", "after.floor", "test.run", "accept.links", ...hookSteps].sort(),
    );
    const everything = `${BASE}review: "true"\nremote: origin\nrelated_pick_command: "true"\ntypecheck_command: "true"\ntest_command: "true {file} {report}"\nlinks_since: "${"a".repeat(40)}"\nhooks:\n  after_start: "true"\n  before_land: "true"\n  after_land: "true"\n  after_green: "true"\n  after_stop: "true"\n`;
    expect(idle(flowOf(everything))).toEqual(["after.after_green", "after.floor"]);
    expect(idle(flowOf(`${everything}floor_timing: after\n`))).toEqual(["land.floor"]);
    // a step with two reasons says both
    expect(step(flowOf(BASE), "after.after_green").idle).toContain("hooks.after_green");
    expect(step(flowOf(BASE), "after.after_green").idle).toContain("floor_timing");
  });

  test("BR-2540: the code review runs only when hooks.after_land has a command; an unset required key idles its steps", () => {
    const off = step(flowOf(BASE), "after.code_review");
    expect(off.runs).toBe(false);
    expect(off.idle).toContain("hooks.after_land");
    expect(off.keys.map((k) => k.key)).toContain("hooks.after_land");
    expect(step(flowOf(`${BASE}hooks:\n  after_land: "true"\n`), "after.code_review").runs).toBe(true);
    const noFloor = flowOf("tests: []\n");
    for (const id of ["land.floor", "after.floor"]) expect(step(noFloor, id).idle).toContain("floor 没写");
  });

  test("BR-2540: a list value is written whole as one line of JSON", () => {
    const root = withConfig(`${BASE}code_root: src\nshared: [src/kernel, src/util]\n`);
    for (const d of ["src/kernel", "src/util"]) {
      Bun.spawnSync(["mkdir", "-p", join(root, d)]);
      writeFileSync(join(root, d, "a.ts"), "");
    }
    const r = canon(root, "config", "--flow");
    expect(r.code).toBe(0);
    expect(r.out.split("\n").some((l) => l.startsWith(`    shared = ["src/kernel","src/util"]  `))).toBe(true);
  });

  test("BR-2540: each key has its role; built-in steps name the promise they uphold", () => {
    const f = flowOf(BASE);
    expect(keyIn(step(f, "land.floor"), "floor").role).toBe("required");
    expect(keyIn(step(f, "land.floor"), "floor").why).toBeTruthy();
    expect(keyIn(step(f, "after.push"), "remote").role).toBe("optional");
    expect(keyIn(step(f, "after.push"), "remote").off).toBeTruthy();
    expect(keyIn(step(f, "start.claim"), "claim_lease_hours").role).toBe("tunable");
    expect(step(f, "start.claim").builtin).toBe("P4");
    expect(step(f, "test.check").builtin).toBe("P5");
    expect(step(f, "after.push").builtin).toBeUndefined();
  });

  test("BR-2540: the text lists each stage with its command and each step's state", () => {
    const r = canon(withConfig(BASE), "config", "--flow");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toContain("5 合入 — canon work land");
    expect(lines).toContain("  认领变更：运行，内置（P4）");
    expect(lines).toContain("  推送 main：没开（remote 没写）");
    expect(lines).toContain(`    floor = "test ! -e FAIL"  必需：没有它，canon work land 拒绝合入`);
  });

  test("BR-2540: --flow with --schema is a usage error", () => {
    const r = canon(withConfig(BASE), "config", "--flow", "--schema");
    expect(r.code).toBe(2);
  });

  test("BR-2540: an invalid config exits 2", () => {
    const r = canon(withConfig(`${BASE}bogus: 1\n`), "config", "--flow");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown key");
  });
});

describe("canon config --flow page", () => {
  test("BR-2541: writes .canon/flow.html, ignored by git, and prints its path last", () => {
    const root = withConfig(BASE);
    const r = canon(root, "config", "--flow");
    expect(r.code).toBe(0);
    const page = join(realpathSync(root), ".canon/flow.html");
    expect(existsSync(page)).toBe(true);
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(page);
    expect(sh(root, "status", "--porcelain")).toBe("");
  });

  test("BR-2541: the page loads nothing from the network and embeds the same data as --flow --json", () => {
    const root = withConfig(`${BASE}remote: origin\n`);
    const json = canon(root, "config", "--flow", "--json");
    expect(json.code).toBe(0);
    const html = readFileSync(join(root, ".canon/flow.html"), "utf8");
    for (const bad of ["<script src", "<link", "@import", "url("]) expect(html).not.toContain(bad);
    const embedded = html.match(/<script id="data" type="application\/json">([^<]*)<\/script>/);
    expect(embedded).not.toBeNull();
    expect(JSON.parse(embedded![1]!)).toEqual(JSON.parse(json.out));
  });

  test("BR-2541: every key's yaml reads back as the value shown; an unset hook entry has the placeholder", () => {
    const root = withConfig(`${BASE}code_root: src\nshared: [src/kernel]\n`);
    Bun.spawnSync(["mkdir", "-p", join(root, "src/kernel")]);
    writeFileSync(join(root, "src/kernel/a.ts"), "");
    const r = canon(root, "config", "--flow", "--json");
    expect(r.code).toBe(0);
    const f = JSON.parse(r.out) as FlowView;
    expect(parse(keyIn(step(f, "test.check"), "shared").yaml)).toEqual({ shared: ["src/kernel"] });
    expect(parse(keyIn(step(f, "start.claim"), "claim_lease_hours").yaml)).toEqual({ claim_lease_hours: 12 });
    expect(parse(keyIn(step(f, "after.push"), "remote").yaml)).toEqual({ remote: null });
    expect(parse(keyIn(step(f, "after.after_land"), "hooks.after_land").yaml)).toEqual({ hooks: { after_land: "<命令>" } });
    for (const k of f.stages.flatMap((s) => s.steps.flatMap((st) => st.keys))) {
      const back = parse(k.yaml) as Record<string, unknown>;
      const [base, part] = k.key.split(".");
      const shown = k.set ? k.value : k.default;
      if (part === undefined) expect(back).toEqual({ [base!]: shown });
      else expect(back).toEqual({ [base!]: { [part]: shown ?? "<命令>" } });
    }
  });

  test("BR-2541: the page has no form, makes no request, has only the filter checkbox, and its scripts parse", () => {
    const root = withConfig(BASE);
    expect(canon(root, "config", "--flow").code).toBe(0);
    const html = readFileSync(join(root, ".canon/flow.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const bad of ["<form", "fetch(", "XMLHttpRequest", "WebSocket"]) expect(html).not.toContain(bad);
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('type="checkbox"');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    // reason: constructing a Function parses its body without running it, so a syntax error in the page script fails here (BR-2541)
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  test("BR-2541: the page is a snapshot: a config change shows only after canon config --flow runs again", () => {
    const root = withConfig(BASE);
    const page = join(root, ".canon/flow.html");
    expect(canon(root, "config", "--flow").code).toBe(0);
    // the remote's YAML snippet as the page shows it, read from the data the page embeds
    const remoteYaml = () => {
      const data = readFileSync(page, "utf8").match(/<script id="data" type="application\/json">([^<]*)<\/script>/)![1]!;
      return keyIn(step(JSON.parse(data) as FlowView, "after.push"), "remote").yaml;
    };
    const before = readFileSync(page, "utf8");
    expect(remoteYaml()).toBe("remote: ");
    writeFileSync(join(root, "canon/config.yaml"), `${BASE}remote: origin\n`);
    sh(root, "commit", "-qam", "push to origin");
    expect(canon(root, "config").code).toBe(0);
    expect(readFileSync(page, "utf8")).toBe(before);
    expect(canon(root, "config", "--flow").code).toBe(0);
    expect(remoteYaml()).toBe('remote: "origin"');
  });

  test("BR-2541: canon brief writes no page", () => {
    const root = withConfig(BASE);
    canon(root, "brief");
    expect(existsSync(join(root, ".canon/config.schema.json"))).toBe(true);
    expect(existsSync(join(root, ".canon/flow.html"))).toBe(false);
  });

  test("BR-2541: canon config without --flow writes no page", () => {
    const root = withConfig(BASE);
    expect(canon(root, "config").code).toBe(0);
    expect(existsSync(join(root, ".canon/flow.html"))).toBe(false);
  });

  test("BR-2541: a page that cannot be written is said in one line, the flow still printed, exit 0", () => {
    const root = withConfig(BASE);
    writeFileSync(join(root, ".canon"), "not a directory\n");
    sh(root, "add", ".canon");
    sh(root, "commit", "-qm", "a file named .canon");
    const r = canon(root, "config", "--flow");
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 会话开始 — canon brief");
    expect(r.out.split("\n").filter((l) => l.startsWith("cannot write .canon/flow.html:"))).toHaveLength(1);
    const j = canon(root, "config", "--flow", "--json");
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out).stages).toHaveLength(8);
    expect(j.err).toContain("cannot write .canon/flow.html:");
  });
});
