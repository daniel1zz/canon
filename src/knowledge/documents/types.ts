/**
 * Document types (D-2 §2, D-3, D-61). Five are built in and cannot be removed or reshaped; a project may
 * declare more in `canon/config.yaml` under `types:`. Every reader of the corpus (ids, check, search,
 * context, allocation) works from this list, so a declared type behaves like a built-in one.
 */
import type { ItemDeclaration } from "./items/model.ts";
import { BUILTIN_ITEM_DECLARATIONS } from "./items/builtin.ts";
import type { FieldDeclaration } from "./fields.ts";

/** Why a decision revises another, as its `revised_because` front matter says (BR-2492). */
export const REVISION_REASONS = ["premise", "requirement", "external", "experience", "implementation", "undetermined"] as const;
/** Who judges a quality standard (BR-2553). */
export const JUDGES = ["test", "agent", "owner"] as const;

/** A built-in field the session states when the document is created (BR-2623); its value is checked by canon's own reader. */
const stated = (name: string, type: FieldDeclaration["type"], none: boolean): FieldDeclaration => ({ name, type, none, due: "create", own: true });

export interface DocType {
  /** Type name used in config, templates (`canon/templates/<name>.md`) and `canon doc --type`. */
  readonly name: string;
  /** Id prefix: `BR` gives `BR-12`. Unique across types. */
  readonly prefix: string;
  /** Directory under `canon/`. Rules live one level deeper, in `rules/<domain>/`. */
  readonly dir: string;
  /** Allowed statuses; undefined for a type without status (notes). */
  readonly statuses: readonly string[] | undefined;
  readonly defaultStatus: string | undefined;
  /** Declared front-matter fields: their shape and whether they are stated at creation (BR-2619, D-159). */
  readonly fields: readonly FieldDeclaration[];
  /**
   * `## ` sections every document of this type must have, each with content (BR-2091). Extra sections are
   * allowed. Rules keep their own fixed shape (BR-2033, BR-2034), so the rule type declares none here.
   */
  readonly sections: readonly string[];
  /** Item declarations of sections (BR-2546): built-in ones from canon's code, project ones from `types.<type>.items`. */
  readonly items: Readonly<Record<string, ItemDeclaration>>;
  readonly builtin: boolean;
}

export const BUILTIN_TYPES: readonly DocType[] = [
  { name: "rule", prefix: "BR", dir: "rules", statuses: ["active", "retired", "planned"], defaultStatus: "active", fields: [stated("business", "text", false)], sections: [], items: {}, builtin: true },
  { name: "decision", prefix: "D", dir: "decisions", statuses: ["proposed", "accepted", "superseded"], defaultStatus: "proposed", fields: [stated("amends", "ids", true), { name: "revised_because", type: "enum", values: REVISION_REASONS, none: false, own: true }], sections: ["背景", "方案", "决定", "后果"], items: {}, builtin: true },
  { name: "change", prefix: "C", dir: "changes", statuses: ["open", "done", "dropped"], defaultStatus: "open", fields: [stated("owner_gate", "text", true), stated("advances", "ids", true)], sections: ["为什么", "要改什么"], items: BUILTIN_ITEM_DECLARATIONS["change"] ?? {}, builtin: true },
  { name: "note", prefix: "N", dir: "notes", statuses: undefined, defaultStatus: undefined, fields: [], sections: [], items: {}, builtin: true },
  // reason: built in, not declared, because only canon's code can write `shipped_at`, run `canon release` and freeze a shipped release (D-61)
  { name: "release", prefix: "R", dir: "releases", statuses: ["planned", "active", "shipped", "dropped"], defaultStatus: "planned", fields: [stated("features", "ids", true)], sections: ["目标", "用户", "范围", "不做", "成功标准", "故事地图切片"], items: {}, builtin: true },
  // reason: built in beside release, because a release lists its features and the release checks read both (D-130)
  { name: "feature", prefix: "F", dir: "features", statuses: ["active", "dropped"], defaultStatus: "active", fields: [], sections: ["目标", "范围", "不做", "成功标准"], items: {}, builtin: true },
  // reason: built in, not declared, because only canon's code checks the aspect list, reminds when none exists and reviews it (D-145, D-146)
  { name: "quality", prefix: "Q", dir: "quality", statuses: ["draft", "active", "retired"], defaultStatus: "draft", fields: [stated("aspect", "text", false), { name: "judge", type: "enum", values: JUDGES, none: false, due: "create", own: true }, stated("covers", "ids", false)], sections: ["门槛", "来源"], items: {}, builtin: true },
];

/**
 * Front-matter keys canon itself owns; a declared field may not reuse one.
 * reason: `plan` and `steps` stay reserved after D-148 removed plans: closed changes and in-flight branches still carry them (BR-2594)
 */
export const RESERVED_FIELDS = new Set(["id", "title", "status", "untested", "lists", "supersedes", "rules", "code", "passes", "release", "changed_in", "shipped_at", "plan", "steps", "links", "feature", "features", "merged_into", "owner_answers", "advances", "issues", "depends_on", "done_by", "chore", "landed_in"]);

/** Directories under canon/ that are not document types. */
export const RESERVED_DIRS = new Set(["templates"]);

export function typeNamed(types: readonly DocType[], name: string): DocType | undefined {
  return types.find((t) => t.name === name);
}

export function typeOfId(types: readonly DocType[], id: string): DocType | undefined {
  const prefix = id.split("-")[0];
  return types.find((t) => t.prefix === prefix);
}

/** Matches any document id of the given types anywhere in text (global; group 1 is the prefix, group 2 the number). */
export function idPattern(types: readonly DocType[]): RegExp {
  const prefixes = [...types].map((t) => t.prefix).sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(${prefixes.join("|")})-(\\d+)\\b`, "g");
}

/** Every id of the given types written in `text`. */
export function idsIn(types: readonly DocType[], text: string): Set<string> {
  return new Set([...text.matchAll(idPattern(types))].map((m) => `${m[1]}-${m[2]}`));
}
