import { err, ok } from "../../kernel/result.ts";
import { configKey } from "../../invocation/key.ts";

/** A full git commit id: SHA-1 (40) or SHA-256 (64) hex characters. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** canon/config.yaml key of the suspect references (BR-2424, D-95). */
export const linksKeys = {
  linksSince: configKey<string | undefined>({
    key: "links_since",
    doc: "The full id of the commit before which every reference between rules and decisions counts as confirmed: an unconfirmed reference the referring document already named there is compared with the named document as it was there, one written later is suspect until confirmed (BR-2424, D-95). Unset, or a commit HEAD does not contain, makes canon links fail with exit 4 instead of guessing.",
    default: undefined,
    schema: { type: ["string", "null"], pattern: FULL_COMMIT.source },
    read: (v) => {
      if (v === null) return ok(undefined);
      return typeof v === "string" && FULL_COMMIT.test(v) ? ok(v) : err("invalid", "`links_since` must be a full commit id (40 hex characters), such as the output of git rev-parse main");
    },
    listed: 217,
    checked: 217,
  }),
};
