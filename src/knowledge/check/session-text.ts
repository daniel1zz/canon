import { agentSession, SKILL_DIRS } from "../../kernel/agent.ts";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** One part of the text every session loads at start, measured in UTF-8 bytes, never judged by content (D-37). */
export interface SessionTextPart {
  /** `CLAUDE.md`, `work guide`, or `.claude/skills/<name>/SKILL.md description`. */
  readonly label: string;
  readonly kind: "instructions" | "guide" | "skill";
  readonly bytes: number;
  /** Why the part counts as 0 bytes, when it does. */
  readonly note?: "no description" | "symbolic link, not read";
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const isLink = (p: string) => lstatSync(p).isSymbolicLink();

/** The parts BR-2256 lists, in its order: root CLAUDE.md, the work guide canon brief prints, each skill description. */
export function sessionText(root: string, guide: string): SessionTextPart[] {
  const parts: SessionTextPart[] = [];
  const runtime = agentSession()?.runtime ?? (existsLink(join(root, SKILL_DIRS.codex, ".canon-skills.json")) && !existsLink(join(root, SKILL_DIRS.claude, ".canon-skills.json")) ? "codex" : "claude");
  const override = join(root, "AGENTS.override.md");
  const instruction = runtime === "claude" ? "CLAUDE.md" : existsLink(override) && (isLink(override) || readFileSync(override, "utf8").trim() !== "") ? "AGENTS.override.md" : "AGENTS.md";
  const path = join(root, instruction);
  if (existsLink(path)) parts.push(isLink(path) ? { label: instruction, kind: "instructions", bytes: 0, note: "symbolic link, not read" } : { label: instruction, kind: "instructions", bytes: bytes(readFileSync(path, "utf8")) });
  parts.push({ label: "work guide", kind: "guide", bytes: bytes(guide) });
  const skills = SKILL_DIRS[runtime];
  const dir = join(root, skills);
  if (!existsSync(dir) || isLink(join(root, skills.split("/")[0]!)) || isLink(dir)) return parts;
  for (const name of readdirSync(dir).sort()) {
    const label = `${skills}/${name}/SKILL.md description`;
    const skillDir = join(dir, name);
    const file = join(skillDir, "SKILL.md");
    if (isLink(skillDir) || (existsLink(file) && isLink(file))) {
      parts.push({ label, kind: "skill", bytes: 0, note: "symbolic link, not read" });
      continue;
    }
    if (!existsSync(file)) continue;
    const description = skillDescription(readFileSync(file, "utf8"));
    parts.push(description === undefined ? { label, kind: "skill", bytes: 0, note: "no description" } : { label, kind: "skill", bytes: bytes(description) });
  }
  return parts;
}

/** True when something, a dangling link included, is at `p`. */
function existsLink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function skillDescription(text: string): string | undefined {
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  if (!front) return undefined;
  try {
    const meta = parse(front[1]!) as { description?: unknown } | null;
    return typeof meta?.description === "string" ? meta.description : undefined;
  } catch {
    return undefined;
  }
}

const total = (parts: readonly SessionTextPart[]) => parts.reduce((a, p) => a + p.bytes, 0);

/** The lines `canon check --sizes` writes to standard error (BR-2256). */
export function sizeLines(parts: readonly SessionTextPart[], budget: number | undefined): string[] {
  return [
    ...parts.map((p) => `session-text ${p.label}: ${p.bytes} bytes${p.note ? ` (${p.note})` : ""}`),
    `session-text total: ${total(parts)} bytes, ${budget === undefined ? "no budget (session_text_budget)" : `budget ${budget}`}`,
  ];
}

/** The hint line when the total is over the budget, else undefined; a hint, never a finding (BR-2257). */
export function budgetHint(parts: readonly SessionTextPart[], budget: number | undefined): string | undefined {
  const sum = total(parts);
  if (budget === undefined || sum <= budget) return undefined;
  const of = (kind: SessionTextPart["kind"]) => total(parts.filter((p) => p.kind === kind));
  return `hint session-text: ${sum} bytes loaded every session, over session_text_budget ${budget} (${parts.find((p) => p.kind === "instructions")?.label ?? "CLAUDE.md"} ${of("instructions")}, work guide ${of("guide")}, skill descriptions ${of("skill")}); canon check --sizes lists each part`;
}
