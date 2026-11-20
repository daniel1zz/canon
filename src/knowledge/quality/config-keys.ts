import { err, ok } from "../../kernel/result.ts";
import { configKey, TUNABLE } from "../../invocation/key.ts";

/** How many landed changes on a standard's covered paths make a verdict stale (BR-2589, D-145). */
export const DEFAULT_STALE_AGENT = 30;
export const DEFAULT_STALE_OWNER = 150;

const whole = (key: string) => (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? ok(v) : err("invalid", `\`${key}\` must be a whole number of at least 1`));

/** canon/config.yaml keys of the quality standards' verdict staleness (BR-2589, D-145). */
export const qualityKeys = {
  qualityStaleAgent: configKey<number>({
    key: "quality_stale_agent",
    doc: "How many changes landed on a quality standard's covered paths after an agent's or a test's verdict make it stale and put the standard on the agenda (BR-2589, D-145). The owner's verdicts use `quality_stale_owner`.",
    default: DEFAULT_STALE_AGENT,
    schema: { type: "integer", minimum: 1, default: DEFAULT_STALE_AGENT },
    read: whole("quality_stale_agent"),
    flow: { steps: ["session.reminders"], role: TUNABLE },
    listed: 230,
    checked: 230,
  }),
  qualityStaleOwner: configKey<number>({
    key: "quality_stale_owner",
    doc: "How many changes landed on a quality standard's covered paths after the owner's verdict make it stale and put the standard on the agenda (BR-2589, D-145); much larger than `quality_stale_agent`, because the owner's attention is scarce.",
    default: DEFAULT_STALE_OWNER,
    schema: { type: "integer", minimum: 1, default: DEFAULT_STALE_OWNER },
    read: whole("quality_stale_owner"),
    flow: { steps: ["session.reminders"], role: TUNABLE },
    listed: 231,
    checked: 231,
  }),
};
