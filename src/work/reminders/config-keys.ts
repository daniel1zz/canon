import { configKey, MINUTE, positiveNumber, positiveValue } from "../../invocation/key.ts";

/** canon/config.yaml keys of reminders (BR-2528, D-136). */
export const reminderKeys = {
  remindEveryMs: configKey<number>({
    key: "remind_every_minutes",
    doc: "How often canon work watch says again the due items still open, on one `still` line (BR-2528).",
    default: 30 * MINUTE,
    schema: positiveNumber(30),
    read: positiveValue("remind_every_minutes", MINUTE),
    listed: 223,
    checked: 223,
  }),
};
