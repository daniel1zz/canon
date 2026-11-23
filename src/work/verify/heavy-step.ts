import { ok, type Result } from "../../kernel/result.ts";
import type { Workspace } from "../workspace.ts";
import { machineLoad, passLoadGate, type LoadDeps, type Passed, type StepKind } from "./load-gate.ts";

/**
 * The gate of one heavy step (BR-2630): the load queue of load-gate.ts with this repository's `delegate_max_load_per_cpu`
 * and the coordination events `load.wait` and `load.start` written for the step's subject.
 */

/**
 * `CANON_HEAVY_STEP=1` is in the environment of the project commands a heavy step runs; a heavy step started inside one
 * (a `test_command` that calls `canon heavy run`) does not pass the gate again, or the outer step would wait for the inner
 * one and the inner for the load to fall (BR-2630, BR-2631).
 */
export const HEAVY_ENV_NAME = "CANON_HEAVY_STEP";
export const HEAVY_ENV: Readonly<Record<string, string>> = { [HEAVY_ENV_NAME]: "1" };
export const insideHeavyStep = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => env[HEAVY_ENV_NAME] === "1";
/** Variables this process removed from `process.env` that the project commands it starts still see (BR-2307). */
const startedWith: Record<string, string> = {};
/**
 * Removes `name` from `process.env` while the project commands a heavy step runs still get it: a spawn with an explicit
 * env no longer falls back to the environment the process started with, as one without did (BR-2307, BR-2390).
 */
export function hideFromSelf(name: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined) startedWith[name] = value;
  delete process.env[name];
  return value;
}
/** `process.env` for a project command a heavy step runs, with the variables hideFromSelf removed. */
export const heavyEnv = (): Record<string, string> => ({ ...startedWith, ...(process.env as Record<string, string>), ...HEAVY_ENV });

/** One pass for a batch of steps: the first call passes the gate, later calls get the same answer (BR-2630). */
export function gateOnce(pass: () => Promise<Result<Passed>>): () => Promise<Result<Passed>> {
  let once: Promise<Result<Passed>> | undefined;
  return () => (once ??= pass());
}

export interface HeavyStep {
  readonly kind: StepKind;
  /** The change or chore, `main` for the background floor, or the executor when nothing is claimed. */
  readonly subject: string;
  readonly worktree: string;
  readonly say: (line: string) => void;
  /** Turns true when the step is stopped while it waits. */
  readonly aborted?: () => boolean;
  readonly deps?: LoadDeps;
}

/** A step started by the gate of another one passes at once. */
export async function passHeavyStep(ws: Pick<Workspace, "db" | "actor" | "config">, step: HeavyStep, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Result<Passed>> {
  if (insideHeavyStep(env)) return ok("go");
  return passLoadGate(step.deps ?? machineLoad, {
    kind: step.kind, subject: step.subject, worktree: step.worktree, perCpu: ws.config.delegateMaxLoadPerCpu, say: step.say, aborted: step.aborted ?? (() => false),
    record: (kind, detail) => void ws.db.event(ws.actor, kind, step.subject === "main" ? null : step.subject, detail),
  });
}
