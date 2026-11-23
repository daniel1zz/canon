import { configKey, countEntry, positiveEntry, readGroup, TUNABLE } from "../../invocation/key.ts";
import { err, ok, type Result } from "../../kernel/result.ts";
import { TIERS, type Tier } from "../priority/tiers.ts";

/** `policies.agenda` (BR-2639, D-164): the thresholds of the main session's agenda. */
export interface AgendaPolicy {
  /** A delegated change this many hours past its last delegation is slow (BR-2612). */
  readonly slow_hours: number;
  /** This many failed `canon work test` runs in a row make a delegated change slow (BR-2612). */
  readonly slow_test_failures: number;
  /** The tiers whose changes interrupt when nothing moves them (BR-2606). */
  readonly interrupt_tiers: readonly Tier[];
  /** How many days a test that passed on a rerun stays on the agenda as flaky (BR-2534). */
  readonly flaky_days: number;
}

export const AGENDA_DEFAULTS: AgendaPolicy = { slow_hours: 6, slow_test_failures: 4, interrupt_tiers: ["P0", "P1"], flaky_days: 7 };

const tiersEntry = (v: unknown, name: string): Result<readonly Tier[]> =>
  Array.isArray(v) && v.every((t) => typeof t === "string" && (TIERS as readonly string[]).includes(t)) ? ok(v as Tier[]) : err("invalid", `\`${name}\` must be a list of tiers from ${TIERS.join(", ")}`);

export const reminderKeys = {
  agendaPolicy: configKey<AgendaPolicy>({
    key: "policies.agenda",
    doc: "The agenda's thresholds: slow_hours and slow_test_failures (BR-2612), interrupt_tiers (BR-2606), flaky_days (BR-2534); an entry left out keeps its default (BR-2639).",
    default: AGENDA_DEFAULTS,
    schema: {
      type: ["object", "null"],
      additionalProperties: false,
      default: AGENDA_DEFAULTS,
      properties: {
        slow_hours: { type: "number", exclusiveMinimum: 0, default: 6 },
        slow_test_failures: { type: "integer", minimum: 1, default: 4 },
        interrupt_tiers: { type: "array", items: { enum: [...TIERS] }, default: ["P0", "P1"] },
        flaky_days: { type: "number", exclusiveMinimum: 0, default: 7 },
      },
    },
    read: (v) => readGroup("policies.agenda", v, AGENDA_DEFAULTS, { slow_hours: positiveEntry, slow_test_failures: countEntry, interrupt_tiers: tiersEntry, flaky_days: positiveEntry }),
    flow: { steps: ["session.reminders"], role: TUNABLE },
    listed: 400,
    checked: 400,
  }),
};
