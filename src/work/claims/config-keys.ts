import { configKey, HOUR, positiveNumber, positiveValue, TUNABLE } from "../../invocation/key.ts";

/** canon/config.yaml keys of claims (C-135). */
export const claimKeys = {
  claimLeaseMs: configKey<number>({
    key: "claim_lease_hours",
    doc: "How long a claim lasts without being renewed (BR-2011).",
    default: 12 * HOUR,
    schema: positiveNumber(12),
    read: positiveValue("claim_lease_hours", HOUR),
    flow: {
      steps: ["start.claim"],
      role: TUNABLE,
    },
    listed: 90,
    checked: 130,
  }),
};
