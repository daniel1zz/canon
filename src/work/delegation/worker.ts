/** A worker: an actor with a name part, `agent:<session>:<name>` (BR-2023, D-128); a main session or a person has none. */
export const isWorker = (actor: string): boolean => actor.startsWith("agent:") && actor.split(":").length >= 3;
