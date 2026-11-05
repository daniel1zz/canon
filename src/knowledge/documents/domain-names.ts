/**
 * Last domain-name segments that name a technical layer, not a business capability (BR-2317). A domain named like
 * one gets a hint when it is created and a note from `canon check`; neither blocks anything.
 */
export const TECHNICAL_LAYER_WORDS: readonly string[] = [
  "cli", "api", "config", "configuration", "db", "database", "ui", "utils", "util", "common", "core", "shared",
  "helpers", "lib", "misc", "infra", "infrastructure", "model", "models", "service", "services", "controller", "controllers",
];

/** The technical-layer word a domain name ends in, or undefined. */
export function technicalLayerWord(domain: string): string | undefined {
  const last = domain.split("/").pop() ?? "";
  return TECHNICAL_LAYER_WORDS.find((w) => w === last);
}

/** One line telling the person to name the domain by business capability (BR-2317, BR-2318). */
export function technicalNameAdvice(domain: string, word: string): string {
  return `domain ${domain} is named after a technical layer (\`${word}\`); name domains by business capability, what the business does, not how the code is built (the canon-domains skill covers how)`;
}
