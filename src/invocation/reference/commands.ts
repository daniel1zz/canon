import { defineCommand } from "citty";
import { join } from "node:path";
import { entry, fail, json, say, workspace, type DomainCommands } from "../command.ts";
import { flowPage } from "./flow-page.ts";
import { FLOW_PAGE, renderFlow, viewFlow } from "./flow-view.ts";
import { modelineHint, renderConfig, schemaText, viewConfig, writeGenerated, writeSchemaFile } from "./reference.ts";

/** `canon config`: every key canon/config.yaml can set, with its value here (BR-2174), or the JSON Schema (BR-2175). */
const configCmd = defineCommand({
  meta: { description: "Every key canon/config.yaml can set: its value in this checkout or its default, and what it does; --flow lists them by step of canon's flow and writes a read-only page, .canon/flow.html; --schema prints the JSON Schema editors use (without reading the config). Exit 2 when the config is invalid" },
  args: {
    schema: { type: "boolean", description: "Print the JSON Schema of canon/config.yaml instead" },
    flow: { type: "boolean", description: "List the keys by stage and step of canon's flow, say which steps are idle, and write .canon/flow.html" },
    json: { type: "boolean" },
  },
  run({ args }) {
    if (args.flow && args.schema) fail({ code: "invalid", message: "--flow and --schema cannot be given together" });
    // reason: the schema does not depend on the config, so --schema prints it without reading one, also when it is invalid (BR-2175)
    if (args.schema) {
      process.stdout.write(schemaText());
      return;
    }
    // reason: opening the workspace reads the config strictly, so a listing that exits 0 also says the config is valid (BR-2045)
    const ws = workspace();
    const views = viewConfig(ws.root);
    const written = writeSchemaFile(ws.root);
    if (args.flow) {
      const flow = viewFlow(join(ws.root, "canon", "config.yaml"), ws.config, views);
      const page = writeGenerated(ws.root, FLOW_PAGE, flowPage(flow));
      // reason: with --json stdout stays JSON, so what could not be written goes to stderr (BR-2541, BR-2176)
      const report = args.json ? (m: string) => console.error(`canon: ${m}`) : say;
      if (args.json) json(flow);
      else say(renderFlow(ws.root, flow));
      for (const r of [written, page]) if (!r.ok) report(r.error.message);
      if (!args.json && page.ok) say(join(ws.root, FLOW_PAGE));
      return;
    }
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
