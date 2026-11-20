import { describe, expect, test } from "bun:test";
import { LESSONS_DECLARATION } from "./builtin.ts";
import type { ItemDeclaration } from "./model.ts";
import { readSectionItems } from "./read.ts";

/** Reading items by a declaration (BR-2547) and the built-in change type's lessons (BR-2551). */

const lessons = (text: string) => readSectionItems(text, LESSONS_DECLARATION);

/** `{text}(?: → {dest})` without the required destination, so a missing one is read rather than reported. */
const ARROW: ItemDeclaration = {
  format: "{text}(?: → {dest})",
  slots: { text: { kind: "text" }, dest: { kind: "pattern", pattern: "\\S.*" } },
  onMismatch: "note",
};

const reading = (declaration: ItemDeclaration, text: string) => readSectionItems(text, declaration);

describe("reading an item's slots", () => {
  test("BR-2547: {text}(?: → {dest}) reads text and dest from a lesson", () => {
    expect(lessons("- 子进程拿不到改过的环境 → BR-2101")).toEqual([
      { raw: "子进程拿不到改过的环境 → BR-2101", slots: { text: "子进程拿不到改过的环境", dest: "BR-2101" }, children: [] },
    ]);
  });

  test("BR-2547: with several arrows the first slot takes as much as it can, so the item splits at the last one", () => {
    const [item] = reading(ARROW, "- A → B 时要先 C → 只靠文字：一次性");
    expect(item?.slots).toEqual({ text: "A → B 时要先 C", dest: "只靠文字：一次性" });
  });

  test("BR-2547: an item without the optional part reads text alone; when dest is required it lacks dest", () => {
    const [plain] = reading(ARROW, "- 没写去向的一句话");
    expect(plain?.slots).toEqual({ text: "没写去向的一句话" });
    const [required] = lessons("- 没写去向的一句话");
    expect(required?.slots).toEqual({ text: "没写去向的一句话" });
    expect(required?.problem).toBe("lacks dest");
  });

  test("BR-2547: an enum value that is not one of the values counts as the optional part being absent, not as a guess", () => {
    const declaration: ItemDeclaration = {
      format: "(?:[{verdict}] ){text}",
      slots: { verdict: { kind: "enum", values: ["采用", "否决"] }, text: { kind: "text" } },
      onMismatch: "note",
    };
    const [item] = reading(declaration, "- [不采用] 太慢");
    expect(item?.slots).toEqual({ text: "[不采用] 太慢" });
  });

  test("BR-2547: a pattern slot reads the marker when it fits, and the text is the whole item when it does not", () => {
    const declaration: ItemDeclaration = {
      format: "(?:[{example}] ){text}",
      slots: { example: { kind: "pattern", pattern: "e\\d+" }, text: { kind: "text" } },
      onMismatch: "note",
    };
    const items = reading(declaration, "- [e3] 输入 → 结果\n- 输入 → 结果");
    expect(items.map((i) => i.slots)).toEqual([{ example: "e3", text: "输入 → 结果" }, { text: "输入 → 结果" }]);
  });

  test("BR-2547: an item that misses a literal of the template is unknown, and the reason names the missing literal", () => {
    const declaration: ItemDeclaration = {
      format: "{topic}：{text}",
      slots: { topic: { kind: "text" }, text: { kind: "text" } },
      onMismatch: "note",
    };
    const [item] = reading(declaration, "- 没有冒号的一句");
    expect(item).toEqual({ raw: "没有冒号的一句", slots: {}, children: [], problem: 'missing "："' });
  });
});

describe("splitting a section into items", () => {
  test("BR-2547: a continuation line joins the item it follows with one space", () => {
    const [item] = reading(ARROW, "- 第一句\n  接着说");
    expect(item?.raw).toBe("第一句 接着说");
  });

  test("BR-2547: no list item in the section means one item per non-empty line", () => {
    const items = reading(ARROW, "第一行\n\n第二行");
    expect(items.map((i) => i.raw)).toEqual(["第一行", "第二行"]);
  });

  test("BR-2547: template placeholder lines are no items", () => {
    expect(reading(ARROW, "<每条一行：…>")).toEqual([]);
  });

  test("BR-2547: with several optional parts the match with the most present wins, and on a tie the earlier part wins", () => {
    const declaration: ItemDeclaration = {
      format: "{text}(?: → {a})(?: → {b})",
      slots: { text: { kind: "text" }, a: { kind: "pattern", pattern: "\\S.*" }, b: { kind: "pattern", pattern: "\\S.*" } },
      onMismatch: "note",
    };
    // both parts present beat either one alone
    expect(reading(declaration, "- x → y → z")[0]?.slots).toEqual({ text: "x", a: "y", b: "z" });
    // one arrow: either part could be the one present, so the earlier part wins
    expect(reading(declaration, "- x → y")[0]?.slots).toEqual({ text: "x", a: "y" });
  });

  test("BR-2547: a declaration's none pattern makes a single matching item mean the section has no items", () => {
    const declaration: ItemDeclaration = { format: "{text}", slots: { text: { kind: "text" } }, none: "^无$", onMismatch: "note" };
    expect(reading(declaration, "无")).toEqual([]);
    const both = reading(declaration, "无\n- 另一条");
    expect(both.map((i) => i.raw)).toEqual(["无", "另一条"]);
  });
});

describe("children", () => {
  test("BR-2547: an indented list item is read by the children declaration; without one it joins the item", () => {
    const withChildren: ItemDeclaration = {
      format: "(?:[{verdict}] ){text}",
      slots: { verdict: { kind: "enum", values: ["采用", "否决"] }, text: { kind: "text" } },
      children: { format: "{text}", slots: { text: { kind: "text" } } },
      onMismatch: "note",
    };
    const items = reading(withChildren, "- [采用] 快\n  - 来源：实测\n  - 备注");
    expect(items[0]?.slots).toEqual({ verdict: "采用", text: "快" });
    expect(items[0]?.children.map((c) => c.raw)).toEqual(["来源：实测", "备注"]);
    const [joined] = reading(ARROW, "- 第一句\n  - 子项");
    expect(joined?.raw).toBe("第一句 子项");
    expect(joined?.children).toEqual([]);
  });
});

describe("the built-in change type's lessons", () => {
  test("BR-2551: a lesson with a destination is text and dest", () => {
    const [item] = lessons("- 子进程拿不到改过的环境 → BR-2101");
    expect(item?.slots).toEqual({ text: "子进程拿不到改过的环境", dest: "BR-2101" });
  });

  test("BR-2551: a lesson may go to the owner as 待负责人确认是否固化", () => {
    const [item] = lessons("- 评审要先看哈希 → 待负责人确认是否固化");
    expect(item?.slots).toEqual({ text: "评审要先看哈希", dest: "待负责人确认是否固化" });
  });

  test("BR-2551: a lesson without an arrow lacks its required destination", () => {
    const [item] = lessons("- 只写了一句话");
    expect(item?.slots).toEqual({ text: "只写了一句话" });
    expect(item?.problem).toBe("lacks dest");
  });

  test("BR-2551: 无, or 无 with an explanation, means the change has no lessons at all", () => {
    expect(lessons("无")).toEqual([]);
    expect(lessons(`无：这是 ${["C", "136"].join("-")} 自己的缺陷`)).toEqual([]);
  });
});
