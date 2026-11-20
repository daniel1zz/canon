// Preloaded by bunfig.toml before every `bun test` in this repository (C-271): a run not started by scripts/test.sh
// would use bun's 5 s test timeout and this machine's git config, so results would differ from the floor's (C-247).
import { relative } from "node:path";

// reason: scripts/test.sh exports this before it starts bun; a plain `bun test` does not have it (C-271)
if (process.env["CANON_TEST_SCRIPT"] !== "1") {
  const first = process.argv[1];
  const file = first && first.endsWith(".ts") ? relative(process.cwd(), first) : "<test file>";
  console.error(
    [
      "bun test refused: in this repository run tests through scripts/test.sh, which sets the 30 s test timeout and a fixed git config (C-247):",
      `  sh scripts/test.sh ${file}`,
      "It takes the same arguments as bun test (e.g. sh scripts/test.sh -t \"BR-2022\"); canon work test runs it for you.",
    ].join("\n"),
  );
  process.exit(2);
}

// reason: full runs queue machine-wide (BR-2576); scripts/test.sh gives the run one temporary queue, but test files run in
// parallel processes, so a test that holds its fixture's floor open would make other files' fixture landings wait for the
// slot and time out. Each test process gets its own queue; spawns that pass { ...process.env } carry it (C-639).
{
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  process.env["CANON_MACHINE_DIR"] = mkdtempSync(join(tmpdir(), "canon-machine-"));
}
