import { FILE_PLACEHOLDER } from "./config-keys.ts";
import { REPORT_PLACEHOLDER } from "./report.ts";

// reason: this module has no other imports on purpose: `canon watch` and the landing checks need the command of one test
// file, and importing it from verify.ts put them inside an import cycle with the load gate (BR-2630)

const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `test_command` with `{file}` replaced by the path and `{report}` by the report path, quoted for sh. */
export function commandFor(template: string, file: string, report?: string): string {
  const withFile = template.replaceAll(FILE_PLACEHOLDER, quoted(file));
  return report === undefined ? withFile : withFile.replaceAll(REPORT_PLACEHOLDER, quoted(report));
}
