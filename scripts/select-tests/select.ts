import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { commandsRegisteredIn, namesCommand, pathsBuiltFromDir, type CliDrive, type RegisteredCommand } from "./cli-tests.ts";
import { readersOfChanged, type DataRead } from "./data-reads.ts";
import { importedPaths } from "./imports.ts";
import { readsOf } from "./skip-reads.ts";

/**
 * This project's `test_select_command` (BR-2346, D-64): given the repository paths a change touched, the test files that
 * can break, each with why. The reading of JS/TS source that canon's `canon work test` once did itself (BR-2157, D-60,
 * issue #117, BR-2181) lives here now, because canon knows no language.
 */

export interface Selected {
  readonly file: string;
  /** Why: `imports …`, `reads …`, `drives canon …`, `runs the CLI …`. */
  readonly reasons: readonly string[];
}

export interface Selection {
  readonly selected: readonly Selected[];
  /** Test files that spawn a CLI whose command table cannot be read; a selection with problems must not be used (BR-2351). */
  readonly problems: readonly string[];
  /** How many test files spawn the CLI and how many distinct commands its table registers. */
  readonly cli: { readonly files: number; readonly commands: number };
}

const JS_TS = /\.[cm]?[jt]sx?$/;

const isFile = (full: string) => existsSync(full) && statSync(full).isFile();

/** Finds the CLI each test spawns and the commands its table registers (D-60). `problems` lists the tests that point at a `main.ts` that gives no usable table. */
export function cliReader(root: string, importsFrom: (file: string) => string[]) {
  const tables = new Map<string, RegisteredCommand[]>();
  const bad: string[] = [];
  let spawning = 0;
  const tableOf = (entry: string): RegisteredCommand[] => {
    let t = tables.get(entry);
    if (!t) {
      t = [];
      const seen = new Set([entry]);
      const queue = [entry];
      while (queue.length) {
        const cur = queue.shift()!;
        if (JS_TS.test(cur) && isFile(join(root, cur))) t.push(...commandsRegisteredIn(cur, readFileSync(join(root, cur), "utf8")));
        for (const next of importsFrom(cur)) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      tables.set(entry, t);
    }
    return t;
  };
  const cliOf = (file: string, text: string): CliDrive | null => {
    for (const entry of pathsBuiltFromDir(file, text)) {
      const isMain = basename(entry) === "main.ts";
      if (!JS_TS.test(entry) || !isFile(join(root, entry))) {
        if (isMain) bad.push(`${file} spawns ${entry}, which is not a file in the project: no CLI entry found`);
        continue;
      }
      const table = tableOf(entry);
      if (table.length) {
        spawning++;
        return { entry, driven: table.filter((c) => namesCommand(text, c.words)) };
      }
      if (isMain) bad.push(`${file} spawns ${entry}, but neither it nor the files it imports register a command with entry("name", rank, command): the command table is empty`);
    }
    return null;
  };
  return {
    tableOf,
    cliOf,
    problems: () => [...bad],
    counts: () => ({ files: spawning, commands: new Set([...tables.values()].flat().map((c) => c.words.join(" "))).size }),
  };
}

/**
 * The test files among `tests` that the change to `changed` can break (BR-2346): test files whose relative imports reach a
 * changed file, directly or through other source files; test files that spawn the CLI and name a command whose module, or a
 * file that module imports, changed; source files that read a changed data file by a path they spell from their own
 * location count as reached like a changed file; test files that themselves read a changed non-code file by a path they
 * spell. `listed` is every file of the project, tracked or not.
 */
export function selectTests(root: string, changed: readonly string[], tests: readonly string[], listed: readonly string[]): Selection {
  const changedSet = new Set(changed);
  // reason: an import written `./a` or `./a.js` must still reach the deleted `a.ts`, so a deleted file resolves as if it were there (BR-2347, issue #53)
  const deleted = new Set(changed.filter((p) => !existsSync(join(root, p))));
  const exists = (p: string) => deleted.has(p) || isFile(join(root, p));
  const importsOf = new Map<string, string[]>();
  const importsFrom = (file: string): string[] => {
    let v = importsOf.get(file);
    if (!v) {
      v = JS_TS.test(file) && isFile(join(root, file)) ? importedPaths(root, file, exists) : [];
      importsOf.set(file, v);
    }
    return v;
  };

  // reason: a module that reads a data file by a path it spells from its own location is not importing it; it counts as reaching the file, so a changed .claude/skills file selects the install tests (#117, D-60)
  const sourceTexts = new Map<string, string>();
  for (const f of listed) if (JS_TS.test(f) && isFile(join(root, f))) sourceTexts.set(f, readFileSync(join(root, f), "utf8"));
  const readers = readersOfChanged(sourceTexts, changed);
  const readNote = (m: string, r: DataRead) => `reads ${r.path} (${r.changed[0]}${r.changed.length > 1 ? ` and ${r.changed.length - 1} more` : ""} changed, via ${m}`;

  const reader = cliReader(root, importsFrom);
  const { tableOf, cliOf } = reader;
  /** The changed files a spawned CLI runs: from its entry file, and from the module of each command the test names. */
  const cliReasons = (cli: CliDrive): string[] => {
    const modules = new Set(tableOf(cli.entry).map((c) => c.module));
    const seeds = new Map<string, string>([[cli.entry, "runs the CLI"]]);
    for (const m of new Set(cli.driven.map((c) => c.module))) {
      seeds.set(m, `drives ${cli.driven.filter((c) => c.module === m).map((c) => `canon ${c.words.join(" ")}`).join(", ")}`);
    }
    const out: string[] = [];
    for (const [start, label] of seeds) {
      const via = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      const reached: string[] = changedSet.has(start) ? [start] : [];
      const readHit: string[] = readers.has(start) ? [start] : [];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const next of importsFrom(cur)) {
          // reason: only the command table (a file that registers no command) imports every command module; following it would select each CLI test for each command's change. Commands import each other for helpers, and that is followed (D-60)
          if (via.has(next) || (modules.has(next) && !modules.has(cur))) continue;
          via.set(next, cur);
          if (changedSet.has(next)) reached.push(next);
          if (readers.has(next)) readHit.push(next);
          queue.push(next);
        }
      }
      for (const target of reached) {
        const chain: string[] = [];
        for (let p = via.get(target) ?? null; p; p = via.get(p) ?? null) chain.unshift(p);
        out.push(`${label} (${target} changed${chain.length ? `, through ${chain.join(" → ")}` : ""})`);
      }
      for (const target of readHit) {
        const chain: string[] = [];
        for (let p = via.get(target) ?? null; p; p = via.get(p) ?? null) chain.unshift(p);
        out.push(`${label} (${readNote(target, readers.get(target)!)}${chain.length ? `, through ${chain.join(" → ")}` : ""})`);
      }
    }
    return out;
  };

  // reason: a test that reads a changed non-code file by a path it spells reaches it even when nothing imports the file; this is the reading `test-reads-skip-path` did for floor_skip_paths (BR-2350, BR-2164)
  const changedData = changed.filter((c) => !JS_TS.test(c));
  const readsChanged = (file: string, text: string): string[] => {
    const out: string[] = [];
    for (const r of readsOf(file, text)) {
      // reason: naming the repository root without reading anything under it (`const ROOT = join(import.meta.dir, "..")`) is no read (BR-2350)
      if (r.path === "" && !r.partial) continue;
      const hit = changedData.find((c) => r.path === "" || c === r.path || c.startsWith(`${r.path}/`));
      if (hit) out.push(`reads ${r.path === "" ? "the repository root" : r.path} (${hit} changed, line ${r.line})`);
    }
    return [...new Set(out)];
  };

  const selected: Selected[] = [];
  for (const file of tests) {
    const reasons: string[] = [];
    // Breadth first, so each changed file is reported through its shortest chain of imports.
    const via = new Map<string, string | null>([[file, null]]);
    const queue = [file];
    const reached: string[] = [];
    const readHit: string[] = readers.has(file) ? [file] : [];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of importsFrom(cur)) {
        if (via.has(next)) continue;
        via.set(next, cur);
        if (changedSet.has(next)) reached.push(next);
        if (readers.has(next)) readHit.push(next);
        queue.push(next);
      }
    }
    for (const target of readHit) {
      const chain: string[] = [];
      for (let p = via.get(target) ?? null; p && p !== file; p = via.get(p) ?? null) chain.unshift(p);
      reasons.push(`${readNote(target, readers.get(target)!)}${chain.length ? `, through ${chain.join(" → ")}` : ""})`);
    }
    for (const target of reached) {
      const chain: string[] = [];
      for (let p = via.get(target) ?? null; p && p !== file; p = via.get(p) ?? null) chain.unshift(p);
      reasons.push(`imports ${target}${chain.length ? ` (through ${chain.join(" → ")})` : ""}`);
    }
    if (JS_TS.test(file)) {
      const text = readFileSync(join(root, file), "utf8");
      const cli = cliOf(file, text);
      if (cli) reasons.push(...cliReasons(cli));
      if (changedData.length) reasons.push(...readsChanged(file, text));
    }
    if (reasons.length) selected.push({ file, reasons });
  }
  return { selected, problems: reader.problems(), cli: reader.counts() };
}
