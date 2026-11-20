import type { ItemDeclaration } from "./model.ts";

/**
 * Built-in item declarations (BR-2546): they live in canon's code, not in a project's config, and a project cannot
 * declare these sections again. BR-2551 is the first one: a change's `教训`.
 */

/**
 * The built-in change type's `教训` section (BR-2551): each lesson is `{text}(?: → {dest})`, where `dest` is where
 * the lesson went (a mechanism's id or name, `只靠文字：<reason>`, or `待负责人确认是否固化`). `dest` is required,
 * and an item the template cannot read is noted, never refused (BR-2549): old changes were written before this
 * declaration existed.
 */
export const LESSONS_DECLARATION: ItemDeclaration = {
  format: "{text}(?: → {dest})",
  slots: {
    text: { kind: "text" },
    // reason: `\S.*` keeps the value non-empty even after trimming, so ` → ` with nothing after it is no value at all (BR-2551)
    dest: { kind: "pattern", pattern: "\\S.*", required: true },
  },
  // reason: a lone 无 line, or 无 followed by an explanation, says the change has no lessons (BR-2551); `none` gives BR-2547 the
  // generic way to make one such line no item, instead of a special case in the reader
  none: "^无(?:$|[。.：:（(，,]|新增)",
  onMismatch: "note",
};

/** Every built-in type's declared sections, by type name then section name. */
export const BUILTIN_ITEM_DECLARATIONS: Readonly<Record<string, Readonly<Record<string, ItemDeclaration>>>> = {
  change: { 教训: LESSONS_DECLARATION },
};
