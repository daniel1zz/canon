/**
 * Document types (D-2 §2, D-3). Four are built in and cannot be removed or reshaped; a project may
 * declare more in `canon/config.yaml` under `types:`. Every reader of the corpus (ids, check, search,
 * context, allocation) works from this list, so a declared type behaves like a built-in one.
 */
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
  /** Extra front-matter fields every document of this type must fill (BR-2054). */
  readonly fields: readonly string[];
  /**
   * `## ` sections every document of this type must have, each with content (BR-2091). Extra sections are
   * allowed. Rules keep their own fixed shape (BR-2033, BR-2034), so the rule type declares none here.
   */
  readonly sections: readonly string[];
  readonly builtin: boolean;
}

export const BUILTIN_TYPES: readonly DocType[] = [
  { name: "rule", prefix: "BR", dir: "rules", statuses: ["active", "retired"], defaultStatus: "active", fields: [], sections: [], builtin: true },
  { name: "decision", prefix: "D", dir: "decisions", statuses: ["proposed", "accepted", "superseded"], defaultStatus: "proposed", fields: [], sections: ["背景", "方案", "决定", "后果"], builtin: true },
  { name: "change", prefix: "C", dir: "changes", statuses: ["open", "done", "dropped"], defaultStatus: "open", fields: [], sections: ["为什么", "要改什么", "任务"], builtin: true },
  { name: "note", prefix: "N", dir: "notes", statuses: undefined, defaultStatus: undefined, fields: [], sections: [], builtin: true },
];

/** Front-matter keys canon itself owns; a declared field may not reuse one. */
export const RESERVED_FIELDS = new Set(["id", "title", "status", "untested", "supersedes", "rules", "code"]);

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
