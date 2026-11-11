import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { land } from "../land.ts";
import { FAST, project, quiet, sh, startNew, ws } from "../../testkit.ts";
import { parseFindings } from "./secrets.ts";

/**
 * The secret scan before the rule review (BR-2407, BR-2408, D-86). varlock is never needed on the machine: each test
 * puts a fake `varlock` in the tree's node_modules/.bin or in a directory on PATH. The fake scan finds SECRET by plain
 * search and, worse than the real varlock, quotes it in full, so a message that echoed its output would show it.
 */
const SECRET = ["sk", "live", "T0PSECRET", "4242"].join("-");

const fakeLoad = {
  ok: `echo '{"API_KEY":"sk▒▒▒▒▒"}'; exit 0`,
  // stdout carries a value on purpose: only stderr may reach the message
  invalid: `echo '{"API_KEY":"${SECRET}"}'; echo 'Configuration is currently invalid' >&2; exit 1`,
};
const fakeScan = {
  search: `shift; [ "$1" = "--" ] && shift; found=0
    for f in "$@"; do n=$(grep -n -F '${SECRET}' "$f" | head -1 | cut -d: -f1)
      if [ -n "$n" ]; then found=1; printf '  %s:%s:9 API_KEY\\n    const k="%s"\\n' "$f" "$n" '${SECRET}' >&2; fi; done
    exit $found`,
  unreadable: `echo 'something new: ${SECRET}' >&2; exit 1`,
};

function fakeVarlock(path: string, name: string, log: string, load = fakeLoad.ok, scan = fakeScan.search) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\ncase "$1" in\n  load) ${load} ;;\n  scan) ${scan} ;;\nesac\nexit 9\n`);
  chmodSync(path, 0o755);
}

const savedPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = savedPath;
});

/** PATH without any directory that holds a varlock, so only the fakes a test adds can be found. */
function pathWithoutVarlock(extra?: string): string {
  const dirs = (savedPath ?? "").split(delimiter).filter((d) => d !== "" && !existsSync(join(d, "varlock")));
  return [...(extra ? [extra] : []), ...dirs].join(delimiter);
}

function fixture(opts: { schema?: boolean; mainFiles?: Record<string, string> } = {}) {
  const root = project();
  const marker = `${root}-review-ran`;
  const log = `${root}-varlock-log`;
  const floor = `${root}-floor-ran`;
  mkdirSync(join(root, "canon/rules/billing"), { recursive: true });
  writeFileSync(join(root, "canon/rules/billing/README.md"), "---\ncode: [src/billing]\n---\n# billing\n\n## 术语\n\n- **退款**：钱退回\n\n## 业务\n\n- **x**：y\n");
  writeFileSync(join(root, "canon/config.yaml"), `floor: "touch ${floor}; test ! -e FAIL"\ntests: []\nreview: 'touch ${marker}; cat > /dev/null; echo ''{"verdict":"ok","findings":[]}'''\n`);
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/billing/.keep"), "");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  if (opts.schema !== false) writeFileSync(join(root, ".env.schema"), "# @defaultSensitive=false\n# ---\n# @sensitive @required\nAPI_KEY=exec(`sops decrypt --extract '[\"API_KEY\"]' secrets.enc.env`)\n");
  for (const [f, text] of Object.entries(opts.mainFiles ?? {})) writeFileSync(join(root, f), text);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "fixture");
  process.env["PATH"] = pathWithoutVarlock();
  return { root, marker, log, floor };
}

/** A change that adds a rule (so the rule review would run) and the given files. */
function change(root: string, files: Record<string, string>, remove: string[] = []) {
  const s = startNew(root, "Change");
  writeFileSync(join(s.worktree, `canon/rules/billing/${["BR", 1].join("-")}.md`), `---\nid: ${["BR", 1].join("-")}\ntitle: Refunds\nuntested: demo\nbusiness: x\n---\n## 规则\n\nRefunds are fine.\n`);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(s.worktree, f), text);
  for (const f of remove) rmSync(join(s.worktree, f));
  sh(s.worktree, "add", "-A");
  sh(s.worktree, "commit", "-qm", "change");
  return s;
}

const refuseDetails = (root: string) =>
  ws(root).db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = ? ORDER BY id").all("land.refuse").map((e) => e.detail);
const logOf = (log: string) => (existsSync(log) ? readFileSync(log, "utf8") : "");

describe("the secret scan refuses a plaintext secret before the rule review (BR-2407)", () => {
  test("BR-2407 BR-2014: a changed file holding a secret value is refused with reason secret, naming file, line and variable but never the value; neither the review nor the floor runs", async () => {
    const { root, marker, log, floor } = fixture();
    const s = change(root, { "app.js": `// config\nconst k = "${SECRET}";\n` });
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("secret");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toContain("app.js:2 API_KEY");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("T0PSECRET");
    const details = refuseDetails(root);
    expect(details.map((d) => JSON.parse(d).reason)).toEqual(["secret"]);
    expect(details.join("\n")).not.toContain("T0PSECRET");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(floor)).toBe(false);
    expect(sh(root, "log", "-1", "--format=%s", "main")).toBe("fixture");
  });

  test("BR-2407: a secret inside a new decision's source URL is refused before the source check, so the URL is never fetched", async () => {
    const { root, log } = fixture();
    const decision = `---\nid: D-1\ntitle: Pick\nstatus: accepted\n---\n## 背景\n\nB.\n\n## 方案\n\n1. A：采用。\n   - 来源：https://api.example/x?key=${SECRET} “refunds are allowed within 30 days”\n2. B：否决。\n\n## 决定\n\nA.\n\n## 后果\n\nC.\n`;
    const s = startNew(root, "Change");
    mkdirSync(join(s.worktree, "canon/decisions"), { recursive: true });
    writeFileSync(join(s.worktree, "canon/decisions/D-1.md"), decision);
    sh(s.worktree, "add", "-A");
    sh(s.worktree, "commit", "-qm", "decision");
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    const fetched: string[] = [];
    const fetcher = async (url: string) => (fetched.push(url), { status: 200, text: "refunds are allowed within 30 days" });
    const out = await land(ws(s.worktree), { ...FAST, fetcher }, quiet);
    expect(out.kind === "refused" && out.reason).toBe("secret");
    expect(out.kind === "refused" ? out.message : "").toContain("canon/decisions/D-1.md:");
    expect(fetched).toEqual([]);
  });

  test("BR-2407: changed files without a secret value pass the scan and the landing goes on to the review", async () => {
    const { root, marker, log } = fixture();
    const s = change(root, { "app.js": "const k = process.env.API_KEY;\n" });
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(logOf(log)).toContain("local load --agent");
    expect(logOf(log)).toContain("app.js");
    expect(existsSync(marker)).toBe(true);
  });

  test("BR-2407: only files this change added or modified are scanned: an untouched file on main with the value and a deleted file are not", async () => {
    const { root, log } = fixture({ mainFiles: { "old.js": `const k = "${SECRET}";\n`, "gone.txt": "bye\n" } });
    const s = change(root, { "app.js": "const k = 1;\n" }, ["gone.txt"]);
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    const scan = logOf(log).split("\n").find((l) => l.startsWith("local scan")) ?? "";
    expect(scan).toContain("app.js");
    expect(scan).not.toContain("old.js");
    expect(scan).not.toContain("gone.txt");
  });

  test("BR-2407: with no .env.schema varlock never runs and a file holding the value lands", async () => {
    const { root, marker, log } = fixture({ schema: false });
    const s = change(root, { "app.js": `const k = "${SECRET}";\n` });
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(existsSync(log)).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  test("BR-2407: only lines naming a scanned file are findings, so a quoted code line is never taken for one", () => {
    const out = "\n🚨 Found 1 sensitive value(s)\n\n  \x1b[36ma b/x:1.js:4:10\x1b[39m \x1b[33mAPI_KEY\x1b[39m\n    other.js:1:2 LEAKED\n";
    expect(parseFindings(out, ["a b/x:1.js"])).toEqual([{ path: "a b/x:1.js", line: 4, name: "API_KEY" }]);
  });
});

describe("varlock missing or unusable fails the landing as an environment error (BR-2408)", () => {
  test("BR-2408: no varlock in node_modules/.bin or on PATH fails with environment, naming varlock and how to install it", async () => {
    const { root, marker } = fixture();
    const s = change(root, { "app.js": "const k = 1;\n" });
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    expect(out.kind === "refused" && out.message).toContain("npm i -D varlock");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2408: the tree's own node_modules/.bin/varlock runs ahead of the one on PATH", async () => {
    const { root, log } = fixture();
    const s = change(root, { "app.js": "const k = 1;\n" });
    const bin = mkdtempSync(join(tmpdir(), "canon-varlock-bin-"));
    fakeVarlock(join(bin, "varlock"), "path", log);
    process.env["PATH"] = pathWithoutVarlock(bin);
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(logOf(log)).toContain("local scan");
    expect(logOf(log)).not.toContain("path ");
  });

  test("BR-2408: with no node_modules/.bin/varlock the one on PATH runs", async () => {
    const { root, log } = fixture();
    const s = change(root, { "app.js": "const k = 1;\n" });
    const bin = mkdtempSync(join(tmpdir(), "canon-varlock-bin-"));
    fakeVarlock(join(bin, "varlock"), "path", log);
    process.env["PATH"] = pathWithoutVarlock(bin);
    expect((await land(ws(s.worktree), FAST, quiet)).kind).toBe("landed");
    expect(logOf(log)).toContain("path scan");
  });

  test("BR-2408: varlock load failing (no age key: Configuration is currently invalid) fails with environment and its stderr, never its stdout, and the review never runs", async () => {
    const { root, marker, log } = fixture();
    const s = change(root, { "app.js": `const k = "${SECRET}";\n` });
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log, fakeLoad.invalid);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    const message = out.kind === "refused" ? out.message : "";
    expect(message).toContain("Configuration is currently invalid");
    expect(message).not.toContain("T0PSECRET");
    expect(logOf(log)).not.toContain("local scan");
    expect(existsSync(marker)).toBe(false);
  });

  test("BR-2408: varlock scan exiting 1 with no finding canon can read fails with environment and does not echo its output", async () => {
    const { root, marker, log } = fixture();
    const s = change(root, { "app.js": "const k = 1;\n" });
    fakeVarlock(join(s.worktree, "node_modules/.bin/varlock"), "local", log, fakeLoad.ok, fakeScan.unreadable);
    const out = await land(ws(s.worktree), FAST, quiet);
    expect(out.kind === "refused" && out.reason).toBe("environment");
    expect(out.kind === "refused" && out.message).not.toContain("T0PSECRET");
    expect(refuseDetails(root).join("\n")).not.toContain("T0PSECRET");
    expect(existsSync(marker)).toBe(false);
  });
});
