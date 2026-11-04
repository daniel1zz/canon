import { defineCommand } from "citty";
import { entry, must, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { sync } from "./remote.ts";

/** `canon sync`: fast-forward main to the configured remote's main, never merging (D-38). */

const syncCmd = defineCommand({
  meta: { description: "Fast-forward main to the main of the git remote named by `remote` in canon/config.yaml; never merges: diverged histories exit 5 and nothing moves" },
  run() {
    must(sync(workspace(), say));
  },
});

export const remoteCommands: DomainCommands = {
  commands: [entry("sync", 126, syncCmd)],
};
