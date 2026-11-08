import { readFileSync, realpathSync } from "node:fs";
import { defineCommand } from "citty";
import { entry, EXIT, fail, json, say, type DomainCommands } from "../../invocation/command.ts";
import { git } from "../../kernel/git.ts";
import { changedFiles, claimedWorktrees, leftOut, snapshotKey, snapshots, takeSnapshot } from "./snapshot.ts";

/** `canon snapshot take` (the PreToolUse hook, BR-2182) and `canon snapshot list` (BR-2184). */

const take = defineCommand({
  meta: { description: "Record this worktree's uncommitted work as a snapshot (run by the hook before each Bash call); --hook reads the cwd from Claude Code's hook input on stdin" },
  args: { hook: { type: "boolean", description: "Read Claude Code's PreToolUse input from stdin and snapshot its cwd" } },
  async run({ args }) {
    let cwd = process.cwd();
    let session = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";
    if (args.hook) {
      // reason: the Bash call may run in another directory than the hook process; the input names it (BR-2182)
      const input = (() => {
        try {
          return JSON.parse(readFileSync(0, "utf8")) as { cwd?: unknown; session_id?: unknown };
        } catch {
          return {};
        }
      })();
      if (typeof input.cwd === "string" && input.cwd !== "") cwd = input.cwd;
      if (typeof input.session_id === "string" && input.session_id !== "") session = input.session_id;
    }
    // reason: Claude Code reports the session's start folder as cwd while the Bash call works in a worktree `canon work start` made, so the worktrees this session claimed are snapshotted too (BR-2182, D-71)
    const targets = [cwd];
    if (args.hook) {
      const claimed = claimedWorktrees(cwd, session);
      if (!claimed.ok) fail(claimed.error);
      const real = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const seen = new Set([real(cwd)]);
      for (const w of claimed.value) if (!seen.has(real(w))) targets.push(w), seen.add(real(w));
    }
    const results = targets.map((t) => takeSnapshot(t));
    const failed = results.find((x) => !x.ok);
    if (failed && !failed.ok) fail(failed.error);
    const r = results[0]!;
    if (!r.ok) return;
    const pruneErrors = results.flatMap((x) => (x.ok && x.value.kind === "taken" && x.value.pruneError ? [`snapshot ${x.value.ref} taken, but deleting old snapshots failed: ${x.value.pruneError}`] : []));
    if (pruneErrors.length > 0) {
      // reason: the snapshot was made, so the hook must not let `|| echo` say it was not; it says what did fail (BR-2183, #84).
      const what = pruneErrors.join("; ");
      if (args.hook) {
        process.stdout.write(`${JSON.stringify({ systemMessage: `canon: ${what}` })}\n`);
        return;
      }
      console.error(`canon: ${what}`);
      process.exit(EXIT.env);
    }
    // Silent on success: the hook runs before every Bash call, and its output would be noise (BR-2182).
    if (!args.hook) say(r.value.kind === "taken" ? `snapshot ${r.value.ref}${r.value.skipped.length ? ` (left out: ${r.value.skipped.join(", ")})` : ""}` : `no snapshot: ${r.value.why}`);
  },
});

const list = defineCommand({
  meta: { description: "This worktree's snapshots of uncommitted work, newest first, with the files each holds and how to get a file back" },
  args: { json: { type: "boolean" } },
  run({ args }) {
    const top = git(process.cwd(), "rev-parse", "--show-toplevel");
    if (!top.ok) fail(top.error);
    const root = top.value;
    const all = snapshots(root, snapshotKey(root)).map((s) => ({ ...s, files: changedFiles(root, s), leftOut: leftOut(root, s) ?? null }));
    if (args.json) return json(all);
    if (all.length === 0) return say(`no snapshots of ${root}`);
    for (const s of all) {
      say(`${s.ref}  ${s.at}  ${s.files.length} file(s): ${s.files.join(", ")}`);
      if (s.leftOut) say(`  ${s.leftOut}`);
    }
    say(`get a file back: git show <ref>:<path> > <path>, or git restore --source=<ref> -- <path> (the hook snapshots the current state first)`);
  },
});

export const snapshotCommands: DomainCommands = {
  groups: [{ name: "snapshot", rank: 145, meta: { description: "Snapshots of uncommitted work, taken before each Bash call so nothing is lost for good" } }],
  commands: [entry("take", 10, take, "snapshot"), entry("list", 20, list, "snapshot")],
};
