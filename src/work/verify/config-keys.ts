import { err } from "../../kernel/result.ts";
import { configKey, optionalString, stringValue } from "../../config/key.ts";

/** Where `test_command` takes the test file's path (BR-2160). */
export const FILE_PLACEHOLDER = "{file}";

/** canon/config.yaml keys of `canon work test` (C-135). */
export const verifyKeys = {
  testCommand: configKey<string | undefined>({
    key: "test_command",
    doc: "Shell command `canon work test` runs once per selected test file, `{file}` replaced by its path (BR-2160, D-23).",
    default: undefined,
    schema: { anyOf: [{ type: "null" }, { type: "string", maxLength: 0 }, { type: "string", pattern: "\\{file\\}" }] },
    read: (v) => {
      const s = stringValue("test_command")(v);
      if (s.ok && s.value !== undefined && !s.value.includes(FILE_PLACEHOLDER)) {
        return err("invalid", `\`test_command\` must contain ${FILE_PLACEHOLDER}, where the test file's path goes (e.g. "bun test ${FILE_PLACEHOLDER}")`);
      }
      return s;
    },
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 40,
    checked: 60,
  }),
  typecheckCommand: configKey<string | undefined>({
    key: "typecheck_command",
    doc: "Shell command `canon work test` runs once before the selected test files, such as the floor's type-check step; unset runs none (BR-2226).",
    default: undefined,
    schema: optionalString,
    read: stringValue("typecheck_command"),
    commands: (v) => (v === undefined ? [] : [v]),
    listed: 45,
    checked: 65,
  }),
};
