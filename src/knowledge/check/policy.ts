// reason: imported by check.ts and by config-keys.ts, which config.ts loads; a module of its own keeps that free of an import cycle (BR-2641)
/** How a configurable check acts (BR-2641, D-164): `refuse` is a finding, `remind` a note, `off` neither. */
export type CheckAction = "refuse" | "remind" | "off";
/**
 * The checks a project may set, with what they do by default (BR-2641). Only checks that say a document is incomplete
 * or could be better are here; one that says a document is false (a duplicate id, a dangling reference) is never (D-139, D-164).
 */
export const CONFIGURABLE_CHECKS = {
  "doc-missing-section": "refuse",
  "template-unfilled": "refuse",
  "rule-no-example": "refuse",
  "example-before-change": "refuse",
  "decision-options": "remind",
  "rule-business-unmapped": "remind",
  "decision-rule-unlinked": "remind",
  "decision-revision-reason": "remind",
  "domain-no-decision": "remind",
} as const satisfies Readonly<Record<string, CheckAction>>;
export type ConfigurableCheck = keyof typeof CONFIGURABLE_CHECKS;
export type CheckPolicy = { readonly [K in ConfigurableCheck]: CheckAction };
