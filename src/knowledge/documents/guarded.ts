import { guardedMainCheckout } from "../../install/githook.ts";
import { fail, must } from "../../invocation/command.ts";
import type { Workspace } from "../../work/workspace.ts";

/**
 * BR-2409: a `<kind> new` command run where main is checked out and guarded refuses before an id is allocated, since the
 * file could not be committed there and would block every landing as main-dirty. A blank title is left to createDoc,
 * which refuses it with exit 2 (BR-2187).
 */
export function refuseOnGuardedMain(ws: Workspace, kind: string, title: string): void {
  if (title.trim() === "") return;
  if (!must(guardedMainCheckout(ws.root, ws.config.main))) return;
  const main = ws.config.main;
  const why = `this checkout has ${main} checked out and ${main} moves only through canon work land: a ${kind} file written here could not be committed and would block every landing (main-dirty). Nothing was written.`;
  const quoted = `"${title.trim().replace(/["\\$`]/g, (c) => `\\${c}`)}"`;
  const next =
    kind === "change"
      ? `Start the change with \`canon work start --title ${quoted}\`; it writes the change file in the change's own worktree.`
      : `Create it inside a change's worktree: \`canon work start <C-n>\` (or \`--title "<what>"\` for a new change), cd into the path it prints, and run this command there.`;
  fail({ code: "refused", message: `${why} ${next}` });
}
