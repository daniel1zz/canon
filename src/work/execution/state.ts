import type { FloorTiming } from "../watch/config-keys.ts";
import { git } from "../../kernel/git.ts";
import { behaviourHash, parsePasses } from "../../knowledge/documents/behaviour.ts";
import { parseDocFile } from "../../knowledge/documents/docfile.ts";
import type { Change, Corpus, Rule } from "../../knowledge/documents/model.ts";
import { GREEN_REF } from "../watch/watch.ts";

/**
 * A rule's execution state (BR-2246, D-32), derived from the rule's behaviour hash and the pass records of done
 * changes; nothing stores it. With floor_timing after, a record counts only once refs/canon/green, the last commit
 * the background floor passed, holds it too: so a commit no floor has tested never shows a rule as passed.
 */
export type ExecutionState =
  | { readonly kind: "planned" }
  | { readonly kind: "passed"; readonly change: string }
  | { readonly kind: "waiting"; readonly change: string }
  | { readonly kind: "rerun" };

export const STATE_LABEL: Readonly<Record<ExecutionState["kind"], string>> = { planned: "规划中", passed: "已通过", waiting: "待 main 测试", rerun: "待重新执行" };

export const STATE_ORDER: readonly ExecutionState["kind"][] = ["planned", "passed", "waiting", "rerun"];

/** The state of every rule that is not retired, by id. `root` is a checkout of the repository that holds refs/canon/green. */
export function executionStates(root: string, corpus: Corpus, timing: FloorTiming): Map<string, ExecutionState> {
  const done = corpus.docs.filter((d): d is Change => d.kind === "change" && d.status === "done").sort((a, b) => Number(b.id.split("-")[1]) - Number(a.id.split("-")[1]));
  const green = timing === "after" ? greenPasses(root) : undefined;
  const out = new Map<string, ExecutionState>();
  for (const rule of corpus.docs.filter((d): d is Rule => d.kind === "rule" && d.status !== "retired")) {
    if (rule.status === "planned") {
      out.set(rule.id, { kind: "planned" });
      continue;
    }
    const hash = behaviourHash(rule.body);
    const matching = done.filter((c) => c.passes[rule.id]?.hash === hash);
    if (matching.length === 0) {
      out.set(rule.id, { kind: "rerun" });
      continue;
    }
    // reason: before mode tested every main commit before it landed, so a record counts at once; after mode only once green holds it (BR-2246)
    const counted = green === undefined ? matching : matching.filter((c) => green(c.path)?.[rule.id] === hash);
    out.set(rule.id, counted.length > 0 ? { kind: "passed", change: counted[0]!.id } : { kind: "waiting", change: matching[0]!.id });
  }
  return out;
}

/** Reads a change file's pass records at refs/canon/green, by path, cached: rule id → hash. Without the ref, none. */
function greenPasses(root: string): (path: string) => Readonly<Record<string, string>> | undefined {
  const ref = git(root, "rev-parse", "--verify", "--quiet", GREEN_REF);
  const sha = ref.ok && ref.value !== "" ? ref.value : undefined;
  const cache = new Map<string, Record<string, string> | undefined>();
  return (path) => {
    if (sha === undefined) return undefined;
    if (cache.has(path)) return cache.get(path);
    let value: Record<string, string> | undefined;
    const text = git(root, "show", `${sha}:${path}`);
    const parsed = text.ok ? parseDocFile(text.value, path) : undefined;
    if (parsed?.ok && parsed.value.meta["status"] === "done") {
      const passes = parsePasses(parsed.value.meta["passes"]);
      if (typeof passes !== "string") value = Object.fromEntries(Object.entries(passes).map(([id, r]) => [id, r.hash]));
    }
    cache.set(path, value);
    return value;
  };
}
