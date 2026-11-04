import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../../kernel/result.ts";

/**
 * What the injected context is used for (C-34, D-40): skill, MCP and subagent uses counted from this project's
 * Claude Code session records, against what the latest session actually had injected. Read only: it never
 * writes a file or changes a setting; removing anything is the owner's call.
 *
 * The record shapes are Claude Code's own and undocumented; they were checked against real records on
 * 2026-11-04 (D-40). Unparsable lines are counted, and a missing listing is said, so a format change shows.
 */
export type Kind = "skill" | "mcp" | "agent";
export const KINDS: readonly Kind[] = ["skill", "mcp", "agent"];
export const DEFAULT_DAYS = 30;

/** Errors that mean a path was removed after it was listed: another session cleaning old records (BR-2265, issue #94). */
const GONE = new Set(["ENOENT", "ENOTDIR"]);

/** `f()`, or undefined when the path it reads was removed meanwhile; any other error is thrown. */
function unlessGone<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (GONE.has((e as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw e;
  }
}

/** The text of a session file, or undefined when it was deleted after it was listed (BR-2265, issue #94). */
export const readRecords = (file: string): string | undefined => unlessGone(() => readFileSync(file, "utf8"));

/** Claude Code's directory name for a path: every character other than a letter or digit becomes `-` (D-40). */
export const encodePath = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` (BR-2265). */
export function projectsDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env["CLAUDE_CONFIG_DIR"]?.trim();
  return join(dir ? dir : join(homedir(), ".claude"), "projects");
}

export interface Places {
  readonly primary: string;
  /** Where change worktrees live (BR-2047). */
  readonly worktrees: string;
  /** `<git common dir>/canon`, where batch worktrees live. */
  readonly canonDir: string;
}

/** This project's directories under `projects` (BR-2265); sorted for a stable report. */
export function projectDirs(projects: string, at: Places): string[] {
  if (!existsSync(projects)) return [];
  const exact = encodePath(at.primary);
  const prefixes = [`${encodePath(at.worktrees)}-`, `${encodePath(at.canonDir)}-`];
  return (unlessGone(() => readdirSync(projects)) ?? [])
    .filter((d) => d === exact || prefixes.some((p) => d.startsWith(p)))
    .map((d) => join(projects, d))
    .filter((d) => unlessGone(() => statSync(d).isDirectory()) === true)
    .sort();
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of unlessGone(() => readdirSync(dir, { withFileTypes: true })) ?? []) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export interface Use {
  readonly kind: Kind;
  readonly name: string;
  readonly uses: number;
  /** ISO time of the latest use. */
  readonly last: string;
}

export interface Available {
  readonly kind: Kind;
  readonly name: string;
  /** Characters this item injects into every session (BR-2266). */
  readonly size: number;
  /** Time of the latest session in the window that injected it. */
  readonly injected?: string;
}

export interface Unused extends Available {
  /** The latest use, or null when never used. */
  readonly last: string | null;
  /** `project` when this project's own files define the item; otherwise `other`: user, plugin, account or built-in, judged on this project's sessions only (BR-2266, D-57). */
  readonly scope: "project" | "other";
}

export interface UsageReport {
  readonly projects: string;
  readonly dirs: readonly string[];
  readonly files: number;
  readonly skipped: number;
  readonly uses: readonly Use[];
  /** How many sessions in the window the available list comes from; null when none had a skill listing. */
  readonly listing: number | null;
  readonly available: readonly Available[];
  readonly days: number;
  /** Start of the window: available items not used since then are unused. */
  readonly since: string;
  readonly unused: readonly Unused[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** The MCP server of a tool name `mcp__<server>__<tool>`, or undefined. */
const serverOf = (tool: string): string | undefined => {
  if (!tool.startsWith("mcp__")) return undefined;
  const rest = tool.slice(5);
  const end = rest.indexOf("__");
  return end > 0 ? rest.slice(0, end) : undefined;
};
/** An MCP instruction block's name as it appears in tool names: `claude.ai Linear` → `claude_ai_Linear` (BR-2266). */
const serverKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** Each skill's own entry in a listing's text: from `- <name>:` up to the next entry (BR-2266). */
function skillEntries(content: string, names: readonly string[]): Map<string, number> {
  const starts = names
    .map((n) => ({ n, at: content.startsWith(`- ${n}:`) ? 0 : content.indexOf(`\n- ${n}:`) }))
    .filter((s) => s.at >= 0)
    .map((s) => ({ n: s.n, at: s.at === 0 ? 0 : s.at + 1 }))
    .sort((a, b) => a.at - b.at);
  const out = new Map<string, number>();
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : content.length;
    out.set(s.n, content.slice(s.at, end).replace(/\n$/, "").length);
  });
  return out;
}

interface Parsed {
  readonly recs: Rec[];
  readonly skipped: number;
}

function parse(text: string): Parsed {
  const recs: Rec[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (isRec(r)) recs.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { recs, skipped };
}

/** One session's final injected state: its file replayed from the first line (BR-2266). */
function sessionState(recs: readonly Rec[]): { items: Available[]; hasListing: boolean } {
  const skills = new Map<string, number>();
  const agents = new Map<string, number>();
  const instructions = new Map<string, number>();
  const tools = new Map<string, Set<string>>();
  let hasListing = false;
  // reason: the MCP and agent deltas are written just before the full skill listing, so the whole file is replayed (BR-2266)
  for (const r of recs) {
    const a = r["attachment"];
    if (!isRec(a)) continue;
    if (a["type"] === "skill_listing") {
      hasListing = true;
      if (a["isInitial"] === true) skills.clear();
      for (const [n, size] of skillEntries(typeof a["content"] === "string" ? a["content"] : "", strings(a["names"]))) skills.set(n, size);
    } else if (a["type"] === "agent_listing_delta") {
      if (a["isInitial"] === true) agents.clear();
      const lines = strings(a["addedLines"]);
      for (const t of strings(a["addedTypes"])) agents.set(t, lines.find((l) => l.startsWith(`- ${t}:`))?.length ?? 0);
      for (const t of strings(a["removedTypes"])) agents.delete(t);
    } else if (a["type"] === "mcp_instructions_delta") {
      const blocks = strings(a["addedBlocks"]);
      strings(a["addedNames"]).forEach((n, i) => instructions.set(serverKey(n), blocks[i]?.length ?? 0));
      for (const n of strings(a["removedNames"])) instructions.delete(serverKey(n));
    } else if (a["type"] === "deferred_tools_delta") {
      for (const t of strings(a["addedNames"])) {
        const s = serverOf(t);
        if (s) tools.set(s, (tools.get(s) ?? new Set()).add(t));
      }
      for (const t of strings(a["removedNames"])) {
        const s = serverOf(t);
        if (s) tools.get(s)?.delete(t);
      }
    }
  }
  const items: Available[] = [];
  for (const [name, size] of skills) items.push({ kind: "skill", name, size });
  const servers = new Set([...instructions.keys(), ...[...tools].filter(([, t]) => t.size > 0).map(([s]) => s)]);
  for (const name of servers) {
    const names = [...(tools.get(name) ?? [])];
    items.push({ kind: "mcp", name, size: (instructions.get(name) ?? 0) + names.reduce((n, t) => n + t.length + 1, 0) });
  }
  for (const [name, size] of agents) items.push({ kind: "agent", name, size });
  return { items, hasListing };
}

/**
 * The available list: the union of the final states of the sessions with an attachment in the window, each
 * item's size from the latest such session (BR-2266). A session can end before an MCP server connects, so one
 * session alone under-reports what is injected. Null when no session in the window had a skill listing.
 */
function availableFrom(sessions: readonly { file: string; recs: Rec[] }[], since: string): { sessions: number; items: Available[] } | null {
  const inWindow = sessions
    .map((s) => ({ s, last: s.recs.reduce((m, r) => (isRec(r["attachment"]) && typeof r["timestamp"] === "string" && r["timestamp"] > m ? r["timestamp"] : m), "") }))
    .filter((x) => x.last >= since)
    .sort((a, b) => a.last.localeCompare(b.last));
  const items = new Map<string, Available>();
  let listed = 0;
  for (const { s, last } of inWindow) {
    const state = sessionState(s.recs);
    if (state.hasListing) listed++;
    for (const it of state.items) items.set(`${it.kind}\0${it.name}`, { ...it, injected: last });
  }
  return listed === 0 ? null : { sessions: inWindow.length, items: [...items.values()] };
}

/** Whether the project's own files define the item: `.claude/skills/<name>`, `.claude/agents/<name>.md`, or a server in `.mcp.json` (BR-2266). */
export function inProject(primary: string, kind: Kind, name: string): boolean {
  if (kind === "skill") return existsSync(join(primary, ".claude", "skills", name));
  if (kind === "agent") return existsSync(join(primary, ".claude", "agents", `${name}.md`));
  try {
    const servers = (JSON.parse(readFileSync(join(primary, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    return Object.keys(servers).some((k) => serverKey(k) === name);
  } catch {
    // reason: no readable .mcp.json means no project-defined server; the item is then reported as `other`, which only adds a warning (BR-2266)
    return false;
  }
}

const COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/g;

/** Reads this project's session records and reports uses and the long-unused available items (BR-2265, BR-2266). */
/** `read` gives a session file's text, or undefined when it is gone; a test passes its own to remove paths mid-scan. */
export function usageReport(projects: string, at: Places, days: number, now: Date, read: (file: string) => string | undefined = readRecords): Result<UsageReport> {
  const dirs = projectDirs(projects, at);
  if (dirs.length === 0) return err("not_found", `no session records of this project under ${projects} (looked for ${encodePath(at.primary)} and names starting ${encodePath(at.worktrees)}- or ${encodePath(at.canonDir)}-)`);
  let files = 0;
  let skipped = 0;
  const sessions: { file: string; recs: Rec[] }[] = [];
  const counts = new Map<string, { kind: Kind; name: string; uses: number; last: string }>();
  const seen = new Set<string>();
  const commands: { name: string; ts: string; key: string }[] = [];
  const count = (kind: Kind, name: string, ts: string) => {
    const k = `${kind}\0${name}`;
    const c = counts.get(k) ?? { kind, name, uses: 0, last: "" };
    c.uses++;
    if (ts > c.last) c.last = ts;
    counts.set(k, c);
  };
  for (const dir of dirs) {
    for (const file of jsonlFiles(dir)) {
      const text = read(file);
      // reason: a file removed after the listing is skipped, not a crash (BR-2265, issue #94)
      if (text === undefined) continue;
      files++;
      const p = parse(text);
      skipped += p.skipped;
      // reason: only session files sit directly in a project directory; subagent records are not a session's listing (BR-2266)
      if (join(file, "..") === dir) sessions.push({ file, recs: p.recs });
      for (const r of p.recs) {
        const ts = typeof r["timestamp"] === "string" ? r["timestamp"] : "";
        const msg = r["message"];
        if (r["type"] === "assistant" && isRec(msg) && Array.isArray(msg["content"])) {
          for (const b of msg["content"] as unknown[]) {
            if (!isRec(b) || b["type"] !== "tool_use" || typeof b["name"] !== "string") continue;
            const id = typeof b["id"] === "string" ? b["id"] : undefined;
            if (id !== undefined) {
              if (seen.has(id)) continue;
              seen.add(id);
            }
            const input = isRec(b["input"]) ? b["input"] : {};
            const server = serverOf(b["name"]);
            if (b["name"] === "Skill" && typeof input["skill"] === "string") count("skill", input["skill"], ts);
            else if (server) count("mcp", server, ts);
            else if (b["name"] === "Agent" || b["name"] === "Task") count("agent", typeof input["subagent_type"] === "string" ? input["subagent_type"] : "(unspecified)", ts);
          }
        } else if (r["type"] === "user" && isRec(msg)) {
          const text = typeof msg["content"] === "string" ? msg["content"] : JSON.stringify(msg["content"] ?? "");
          const key = typeof r["uuid"] === "string" ? r["uuid"] : `${file}:${ts}`;
          for (const m of text.matchAll(COMMAND)) commands.push({ name: m[1]!, ts, key: `${key}\0${m[1]}` });
        }
      }
    }
  }
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const listing = availableFrom(sessions, since);
  const available = listing?.items ?? [];
  // reason: a slash command is a skill use only when it names a skill, never a built-in such as /model (BR-2265)
  const skillNames = new Set([...available.filter((a) => a.kind === "skill").map((a) => a.name), ...[...counts.values()].filter((c) => c.kind === "skill").map((c) => c.name)]);
  const seenCommands = new Set<string>();
  for (const c of commands) {
    if (!skillNames.has(c.name) || seenCommands.has(c.key)) continue;
    seenCommands.add(c.key);
    count("skill", c.name, c.ts);
  }
  const uses = [...counts.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.uses - a.uses || a.name.localeCompare(b.name));
  const lastOf = (a: Available) => counts.get(`${a.kind}\0${a.name}`)?.last ?? null;
  const unused = available
    .map((a) => ({ ...a, last: lastOf(a), scope: inProject(at.primary, a.kind, a.name) ? ("project" as const) : ("other" as const) }))
    .filter((a) => a.last === null || a.last < since)
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return ok({ projects, dirs, files, skipped, uses, listing: listing?.sessions ?? null, available, days, since, unused });
}

const when = (ts: string | null) => (ts ? ts.slice(0, 16).replace("T", " ") : "never");

export function renderUsage(r: UsageReport): string {
  const lines = [`session records: ${r.files} file(s) in ${r.dirs.length} project director${r.dirs.length === 1 ? "y" : "ies"} under ${r.projects}, ${r.skipped} unreadable line(s) skipped`];
  const titles: Record<Kind, string> = { skill: "skills", mcp: "MCP servers", agent: "subagent types" };
  const nw = Math.max(20, ...r.uses.map((u) => u.name.length), ...r.unused.map((u) => u.name.length));
  for (const kind of KINDS) {
    const mine = r.uses.filter((u) => u.kind === kind);
    lines.push("", `${titles[kind]} used: ${mine.length === 0 ? "none" : ""}`.trimEnd());
    for (const u of mine) lines.push(`  ${u.name.padEnd(nw)} ${String(u.uses).padStart(5)}  ${when(u.last)}`);
  }
  lines.push("");
  if (r.listing === null) {
    lines.push("no listing of available skills found in the session records: cannot tell what is unused");
    return lines.join("\n");
  }
  lines.push(`available: injected in ${r.listing} session(s) in the last ${r.days} days`, `unused for ${r.days} days (not used since ${when(r.since)}), by injected size in characters:`);
  lines.push(`  ${"kind".padEnd(5)} ${"scope".padEnd(7)} ${"name".padEnd(nw)} ${"size".padStart(7)}  ${"last used".padEnd(16)}  last injected`);
  for (const u of r.unused) lines.push(`  ${u.kind.padEnd(5)} ${u.scope.padEnd(7)} ${u.name.padEnd(nw)} ${String(u.size).padStart(7)}  ${when(u.last).padEnd(16)}  ${when(u.injected ?? null)}`);
  if (r.unused.length === 0) lines.push("  (none)");
  lines.push(`total: ${r.unused.length} item(s), ${r.unused.reduce((n, u) => n + u.size, 0)} characters`);
  lines.push("scope other = user, plugin, account or built-in: judged on this project's sessions only, so other projects may use it and a built-in one cannot be removed");
  return lines.join("\n");
}
