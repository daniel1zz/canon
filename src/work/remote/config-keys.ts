import { err, ok } from "../../kernel/result.ts";
import { configKey, positiveNumber, positiveValue } from "../../invocation/key.ts";

/** A git remote name: it is passed to git as an argument, so it never starts with `-` and has no white space. */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/** canon/config.yaml keys of keeping main in step with a git remote (D-38). */
export const remoteKeys = {
  remote: configKey<string | undefined>({
    key: "remote",
    doc: "The git remote main is pushed to after every landing and `canon sync` fast-forwards from (BR-2259, BR-2262), e.g. `origin`; unset means no push.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: REMOTE_NAME.source },
    read: (v) => {
      if (v === null || v === "") return ok(undefined);
      // reason: the name becomes an argument of git push and git fetch; one starting with `-` would be read as an option (D-38)
      return typeof v === "string" && REMOTE_NAME.test(v) ? ok(v) : err("invalid", "`remote` must be the name of a git remote (letters, digits, `.`, `_`, `/`, `-`; not starting with `-`)");
    },
    listed: 210,
    checked: 210,
  }),
  remoteTimeoutMs: configKey<number>({
    key: "remote_timeout_seconds",
    doc: "How long one push to, or fetch from, the remote may take before it is stopped (BR-2260, BR-2262).",
    default: 60_000,
    schema: positiveNumber(60),
    read: positiveValue("remote_timeout_seconds", 1000),
    listed: 211,
    checked: 211,
  }),
};
