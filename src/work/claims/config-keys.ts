import { configKey, HOUR, positiveValue } from "../../config/key.ts";

/** canon/config.yaml keys of claims (C-135). */
export const claimKeys = {
  claimLeaseMs: configKey<number>({
    key: "claim_lease_hours",
    doc: "How long a claim lasts without being renewed (BR-2011).",
    default: 12 * HOUR,
    read: positiveValue("claim_lease_hours", HOUR),
    listed: 90,
    checked: 130,
  }),
};
