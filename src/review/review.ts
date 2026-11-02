import type { Corpus, Doc } from "../knowledge/model.ts";
import { contextFor, renderContext } from "../knowledge/query.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * AI review of rule and decision text, the one place the data showed AI judgment pays (spec/ADR rejects
 * 15/15 real). It sees the whole domain each changed rule belongs to, not a slice, and runs on the exact
 * tree that is landing. The reviewer is any command: prompt on stdin, JSON verdict on stdout.
 */
export interface ReviewVerdict {
  readonly verdict: "ok" | "block";
  readonly findings: readonly string[];
}

export function reviewPrompt(root: string, corpus: Corpus, changed: readonly Doc[]): string {
  const parts: string[] = [
    "You review changes to a project's rules and decisions. Rules are the current truth of what the product must do; decisions record why.",
    "Block only for: a rule that contradicts another active rule or an accepted decision; a rule a test cannot decide (vague, no boundary); a decision without the options it rejected.",
    "Do not block for wording, style or formatting.",
    'Answer with JSON only: {"verdict":"ok"|"block","findings":["<one sentence each, naming the id>"]}',
    "",
    "# Changed documents (new text)",
  ];
  for (const d of changed) parts.push(`## ${d.id} ${d.title} (${d.kind}${"status" in d ? `, ${d.status}` : ""})\n\n${d.body.trim()}\n`);
  const seen = new Set<string>();
  for (const d of changed) {
    const target = d.kind === "rule" ? d.domain : d.id;
    if (seen.has(target)) continue;
    seen.add(target);
    parts.push(`# Current context for ${target}\n\n${renderContext(root, contextFor(corpus, target))}`);
  }
  const accepted = corpus.docs.filter((d) => d.kind === "decision" && d.status === "accepted");
  if (accepted.length) parts.push(`# Accepted decisions\n\n${accepted.map((d) => `- ${d.id} ${d.title}`).join("\n")}`);
  return parts.join("\n");
}

export async function runReview(command: string, cwd: string, prompt: string): Promise<Result<ReviewVerdict>> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) return err("io", `review command exited ${code}: ${errText.trim().slice(0, 500)}`);
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) return err("invalid", `review command printed no JSON: ${out.trim().slice(0, 300)}`);
  try {
    const v = JSON.parse(match[0]) as { verdict?: unknown; findings?: unknown };
    if (v.verdict !== "ok" && v.verdict !== "block") return err("invalid", `review verdict must be "ok" or "block", got ${JSON.stringify(v.verdict)}`);
    const findings = Array.isArray(v.findings) ? v.findings.map(String) : [];
    return ok({ verdict: v.verdict, findings });
  } catch (e) {
    return err("invalid", `review JSON does not parse: ${(e as Error).message}`);
  }
}
