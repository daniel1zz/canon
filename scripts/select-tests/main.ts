import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { selectTests } from "./select.ts";

/**
 * canon's `test_select_command` for this project (BR-2346, D-64): `bun scripts/select-tests/main.ts`, run at the repository
 * root. Standard input: the repository paths a change touched, one per line, deleted ones included. Standard output: one
 * test file per line, a tab, why. A line on standard error says how many tests spawn the CLI; a CLI entry or command table
 * that cannot be read exits 1 with the reason on standard error, since a selection without it would miss tests silently (BR-2351).
 */
const root = process.cwd();
const changed = (await Bun.stdin.text()).split("\n").filter((l) => l !== "");

const raw: unknown = parse(readFileSync(join(root, "canon/config.yaml"), "utf8"));
const globs = raw !== null && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["tests"]) ? ((raw as Record<string, unknown[]>)["tests"] as string[]) : [];
const tests = new Set<string>();
for (const g of globs) for (const f of new Bun.Glob(g).scanSync({ cwd: root, onlyFiles: true })) if (!f.split("/").includes("node_modules")) tests.add(f);

const git = (...args: string[]): string[] => {
  const r = Bun.spawnSync(["git", ...args, "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().split("\0").filter(Boolean);
};
const listed = git("ls-files", "--cached", "--others", "--exclude-standard").filter((f) => existsSync(join(root, f)));

const result = selectTests(root, changed, [...tests].filter((f) => existsSync(join(root, f))).sort(), listed);
if (result.problems.length > 0) {
  console.error(`select-tests: cannot tell which tests spawn the CLI and what they drive:\n${result.problems.map((p) => `  ${p}`).join("\n")}\nThe CLI's entry file or its \`entry(...)\` command registrations changed shape (D-15, D-60); fix scripts/select-tests/cli-tests.ts or the tests' path`);
  process.exit(1);
}
for (const s of result.selected) console.log(`${s.file}\t${s.reasons.join("; ")}`);
console.error(`select-tests: ${result.cli.files} file(s) spawn the CLI, ${result.cli.commands} command(s) known`);
