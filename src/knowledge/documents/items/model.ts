/**
 * Item declarations of a document type's sections and what reading one gives (BR-2546, BR-2547, D-144). This file
 * fixes the shapes the implementation of C-619 builds on; the parser of declarations and the matcher come with it.
 */

/** A slot's type (BR-2546): `text` is prose; every other type is metadata and sits inside an optional part. */
export type SlotType =
  | { readonly kind: "text" }
  | { readonly kind: "id"; readonly required?: boolean }
  | { readonly kind: "ids"; readonly required?: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly required?: boolean }
  | { readonly kind: "pattern"; readonly pattern: string; readonly required?: boolean };

/** One section's declaration, as `types.<type>.items.<section>` writes it or canon builds it in (BR-2546). */
export interface ItemDeclaration {
  /** The template: literal text, `{slot}` and optional parts `(?:…)`, not nested. */
  readonly format: string;
  readonly slots: Readonly<Record<string, SlotType>>;
  /** Indented sub-items, read on their own; no further children. */
  readonly children?: { readonly format: string; readonly slots: Readonly<Record<string, SlotType>> };
  /**
   * When splitting gives exactly one item and this regular expression matches its text, the section has no items
   * (BR-2547): the section's way of saying "there is nothing here", such as a change's lone `无` (BR-2551).
   */
  readonly none?: string;
  /** What canon check does with an item it cannot read or that lacks a required slot (BR-2549); default note. */
  readonly onMismatch: "note" | "finding";
}

/** One item as read (BR-2547, BR-2550). */
export interface ReadItem {
  /** The item's text without its list marker, continuation lines joined by one space. */
  readonly raw: string;
  /** The slots that have a value; a slot of an optional part that did not appear is absent. */
  readonly slots: Readonly<Record<string, string>>;
  readonly children: readonly ReadItem[];
  /** Why the item is unknown or lacks a required slot; absent when it was read in full. */
  readonly problem?: string;
}
