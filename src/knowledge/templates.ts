import type { Kind } from "./model.ts";

/**
 * Built-in document templates. canon/ documents are written in Chinese (product.md, "语言"), so the
 * section headings are Chinese. A rule has exactly two sections: the statement and its examples; the
 * examples are what make the boundary decidable (BR-2033), which `canon check` verifies.
 */
export const RULE_SECTION = "## 规则";
export const EXAMPLE_SECTION = "## 例子";

/**
 * A line that is still a template placeholder: `<...>` alone on a line, or a list item made only of
 * placeholders such as `- <输入> → <结果>`. Placeholders inside backticks are code, not placeholders.
 */
export const PLACEHOLDER_LINE = /^\s*(?:-\s*)?<[^<>`\n]+>(?:\s*→\s*<[^<>`\n]+>)?\s*$/m;

export function templateFor(kind: Kind): string {
  switch (kind) {
    case "rule":
      return [
        RULE_SECTION,
        "",
        "<一句话写清楚：在什么条件下，产品必须怎样。一条规则只描述一个可以独立测试的行为；有多个独立行为就拆成多条规则。>",
        "",
        EXAMPLE_SECTION,
        "",
        "- <边界上的具体输入或状态> → <必须出现的结果>",
        "- <边界另一侧的具体输入或状态> → <必须出现的结果>",
        "",
      ].join("\n");
    case "decision":
      return "## 背景\n\n<为什么需要做这个决定，有哪些事实和数据。>\n\n## 方案\n\n1. <方案一>：<采用或否决，以及理由>\n2. <方案二>：<采用或否决，以及理由>\n\n## 决定\n\n<决定了什么。>\n\n## 后果\n\n<带来哪些变化、代价和后续工作。>\n";
    case "change":
      return "## 为什么\n\n<要解决什么问题。>\n\n## 要改什么\n\n<具体改动，以及会新增或修改哪些规则。>\n\n## 任务\n\n- [ ] <任务>\n";
    case "note":
      return "";
  }
}

export function domainReadme(name: string, description: string): string {
  return `# ${name}\n\n${description || "<这个领域管什么、不管什么。>"}\n\n## 术语\n\n- **<术语>**：<在这个领域里的含义>\n`;
}

/** The text of one `## ` section of a rule body, or undefined when the section is absent. */
export function section(body: string, heading: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}
