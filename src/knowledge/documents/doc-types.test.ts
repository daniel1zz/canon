import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
// Ids are assembled at runtime so this file does not itself name documents when canon check scans the repo.
const id = (p: string, n: number) => [p, n].join("-");

function repo(config: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "canon-doctypes-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
  for (const [p, text] of Object.entries({ "canon/config.yaml": `floor: "true"\n${config}`, ...files })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

function canon(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:test" } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

const body = (root: string, path: string) => readFileSync(join(root, path), "utf8").split("---\n")[2]?.trim();

describe("declared document types, the examples not tested elsewhere", () => {
  test("BR-2050: the first document of a declared type is number 1, named after its title, in the first status", () => {
    const root = repo("types:\n  spec:\n    prefix: SP\n    dir: specs\n    statuses: [draft, approved]\n");
    const r = canon(root, "doc", "new", "--type", "spec", "--title", "Login flow");
    expect([r.code, r.out.trim()]).toEqual([0, `canon/specs/${id("SP", 1)}-login-flow.md`]);
    expect(readFileSync(join(root, r.out.trim()), "utf8")).toContain("status: draft");
  });

  test("BR-2060: canon show prints a declared document's file", () => {
    const text = `---\nid: ${id("SP", 1)}\ntitle: 登录流程\nstatus: draft\n---\n\n## 需求\n\n用户能登录。\n`;
    const root = repo("types:\n  spec:\n    prefix: SP\n    dir: specs\n    statuses: [draft]\n", { [`canon/specs/${id("SP", 1)}.md`]: text });
    const r = canon(root, "show", id("SP", 1));
    expect(r.code).toBe(0);
    expect(r.out).toContain(text);
  });

  test("BR-2093: a template file wins over the required sections; with neither the body is empty", () => {
    const risk = "types:\n  risk:\n    prefix: RK\n    dir: risks\n    sections: [影响, 应对]\n";
    const withTemplate = repo(risk, { "canon/templates/risk.md": "## 影响\n\n<写影响>\n\n## 应对\n\n<写应对>\n\n## 备注\n" });
    const made = canon(withTemplate, "doc", "new", "--type", "risk", "--title", "A").out.trim();
    expect(body(withTemplate, made)).toBe("## 影响\n\n<写影响>\n\n## 应对\n\n<写应对>\n\n## 备注");
    const bare = repo("types:\n  risk:\n    prefix: RK\n    dir: risks\n");
    expect(body(bare, canon(bare, "doc", "new", "--type", "risk", "--title", "B").out.trim())).toBe("");
  });
});
