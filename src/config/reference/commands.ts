import { defineCommand } from "citty";
import { entry, json, say, workspace, type DomainCommands } from "../../cli/command.ts";
import { modelineHint, renderConfig, schemaText, viewConfig, writeSchemaFile } from "./reference.ts";

/** `canon config`: every key canon/config.yaml can set, with its value here (BR-2174), or the JSON Schema (BR-2175). */
const configCmd = defineCommand({
  meta: { description: "Every key canon/config.yaml can set: its value in this checkout or its default, and what it does; --schema prints the JSON Schema editors use (without reading the config). Exit 2 when the config is invalid" },
  args: {
    schema: { type: "boolean", description: "Print the JSON Schema of canon/config.yaml instead" },
    json: { type: "boolean" },
  },
  run({ args }) {
    // reason: the schema does not depend on the config, so --schema prints it without reading one, also when it is invalid (BR-2175)
    if (args.schema) {
      process.stdout.write(schemaText());
      return;
    }
    // reason: opening the workspace reads the config strictly, so a listing that exits 0 also says the config is valid (BR-2045)
    const ws = workspace();
    const views = viewConfig(ws.root);
    const written = writeSchemaFile(ws.root);
    if (args.json) {
      json(views);
      if (!written.ok) console.error(`canon: ${written.error.message}`);
      return;
    }
    say(renderConfig(ws.root, views));
    if (!written.ok) say(written.error.message);
    const hint = modelineHint(ws.root);
    if (hint) say(hint);
  },
});

export const referenceCommands: DomainCommands = { commands: [entry("config", 155, configCmd)] };
