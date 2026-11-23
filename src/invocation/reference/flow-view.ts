import { CONFIG_KEYS, type Config } from "../config.ts";
import { FLOW, type FlowStep, type StepId } from "../flow.ts";
import type { KeyView } from "./reference.ts";

/**
 * canon's flow with this checkout's configuration (BR-2540, D-140): every stage and step of src/invocation/flow.ts,
 * each step with the keys that name it in their `flow`, whether it runs, and what kind each key is.
 */

/** Generated next to the schema, never committed (BR-2541). */
export const FLOW_PAGE = ".canon/flow.html";

export interface FlowKeyView extends KeyView {
  readonly role: "required" | "optional" | "tunable";
  /** For an optional key: how to turn it off. */
  readonly off?: string;
  /** For a required key: what fails without it. */
  readonly why?: string;
  /** What to write in canon/config.yaml for this value; read back as YAML it gives the value shown (BR-2541). */
  readonly yaml: string;
}

/** A hook entry that is not set is shown with this placeholder, to be replaced by a real command. */
export const COMMAND_PLACEHOLDER = "<命令>";

// reason: a JSON value is valid YAML on one line, so the snippet reads back as exactly the value shown (BR-2541)
const scalar = (value: unknown) => (value === null || value === undefined ? "" : JSON.stringify(value));
// reason: a policy group's key is written under its parent mapping, so its yaml reads back as canon/config.yaml writes it (BR-2638)
const yamlOf = (key: string, value: unknown) => (key.includes(".") ? `${key.split(".")[0]}:\n  ${key.split(".").slice(1).join(".")}: ${scalar(value)}` : `${key}: ${scalar(value)}`);
const yamlOfPart = (key: string, part: string, value: unknown) => `${key}:\n  ${part}: ${JSON.stringify(value ?? COMMAND_PLACEHOLDER)}`;

export interface FlowStepView {
  readonly id: StepId;
  readonly title: string;
  readonly about: string;
  readonly runs: boolean;
  /** Why the step does not run, when it does not. */
  readonly idle?: string;
  /** For a step canon always runs: the promise it upholds. */
  readonly builtin?: string;
  readonly keys: readonly FlowKeyView[];
}

export interface FlowStageView {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly steps: readonly FlowStepView[];
}

export interface FlowView {
  /** The canon/config.yaml the values come from. */
  readonly config: string;
  readonly stages: readonly FlowStageView[];
}

const BY_LISTED = [...CONFIG_KEYS].sort((a, b) => a[1].listed - b[1].listed);

/** `views` is viewConfig's list for the same checkout, `config` what readConfig read from it. */
export function viewFlow(configPath: string, config: Config, views: readonly KeyView[]): FlowView {
  const view = new Map(views.map((v) => [v.key, v]));
  const values = config as unknown as Readonly<Record<string, unknown>>;
  const stepView = (step: FlowStep): FlowStepView => {
    const id = step.id as StepId;
    const idle: string[] = [];
    const keys: FlowKeyView[] = [];
    for (const [field, k] of BY_LISTED) {
      if (!k.flow.steps.includes(id)) continue;
      const role = k.flow.role;
      // reason: a step whose required key is unset cannot run, whatever else is configured (BR-2540)
      if (role.kind === "required" && values[field] === undefined) idle.push(`${k.key} 没写：${role.why}`);
      const reason = k.flow.idle?.(values[field], id);
      if (reason) idle.push(reason);
      const v = view.get(k.key);
      if (!v) throw new Error(`viewConfig left out the key ${k.key}`);
      const kind = { role: role.kind, ...(role.kind === "optional" ? { off: role.off } : {}), ...(role.kind === "required" ? { why: role.why } : {}) };
      const part = k.flow.part?.(id);
      if (part === undefined) {
        keys.push({ ...v, ...kind, yaml: yamlOf(k.key, v.set ? v.value : v.default) });
        continue;
      }
      // reason: a mapping key shows only the entry this step uses, so each hook step lists its own event (BR-2540)
      const written = v.set && typeof v.value === "object" && v.value !== null && Object.hasOwn(v.value, part);
      const value = written ? (v.value as Record<string, unknown>)[part] : null;
      keys.push({ ...v, ...kind, key: `${k.key}.${part}`, set: written, value, default: null, yaml: yamlOfPart(k.key, part, value) });
    }
    return {
      id,
      title: step.title,
      about: step.about,
      runs: idle.length === 0,
      ...(idle.length ? { idle: idle.join("; ") } : {}),
      ...("builtin" in step && step.builtin ? { builtin: step.builtin } : {}),
      keys,
    };
  };
  return { config: configPath, stages: FLOW.map((s) => ({ id: s.id, title: s.title, command: s.command, steps: s.steps.map(stepView) })) };
}

const shown = (k: FlowKeyView) => (k.set ? JSON.stringify(k.value) : k.default === null ? "（没写）" : `${JSON.stringify(k.default)}（默认）`);
const roleText = (k: FlowKeyView) => (k.role === "required" ? `必需：${k.why}` : k.role === "optional" ? `可选（${k.off}）` : "可调");

/** The text `canon config --flow` prints (BR-2540); like the page, in Chinese (D-140). */
export function renderFlow(root: string, flow: FlowView): string {
  const lines = [`${root} 的 canon/config.yaml（当前 checkout），按 canon 流程的步骤列出；改它和别的改动一样走合入`];
  flow.stages.forEach((stage, i) => {
    lines.push("", `${i + 1} ${stage.title} — ${stage.command}`);
    for (const step of stage.steps) {
      const state = step.runs ? "运行" : `没开（${step.idle}）`;
      lines.push(`  ${step.title}：${state}${step.builtin ? `，内置（${step.builtin}）` : ""}`);
      for (const k of step.keys) lines.push(`    ${k.key} = ${shown(k)}  ${roleText(k)}`);
    }
  });
  return lines.join("\n");
}
