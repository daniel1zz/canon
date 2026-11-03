
/**
 * Built-in document templates. canon/ documents are written in Chinese (product.md, "语言"), so the
 * section headings are Chinese. A rule has exactly two sections: the statement and its examples; the
 * examples are what make the boundary decidable (BR-2033), which `canon check` verifies.
 */
export const RULE_SECTION = "## 规则";
export const EXAMPLE_SECTION = "## 例子";
/**
 * A change's lessons (BR-2037, D-23): each lesson found while doing the work and where it went, a mechanism's id,
 * "只靠文字：<reason>" or "待负责人确认是否固化"; "无" when there is none. Not a required section of the change type, so
 * the changes closed before it existed stay valid; `canon work land --finish` requires it of the change it closes.
 */
export const LESSONS_SECTION = "## 教训";

/** Whether the body has a `## 教训` section with a line that is not a template placeholder. */
export function hasLessons(body: string): boolean {
  const text = section(body, LESSONS_SECTION);
  return text !== undefined && text.split("\n").some((l) => l.trim() !== "" && !isPlaceholderLine(l));
}

/**
 * A line that is still a template placeholder (BR-2035): once the list marker (`-`, `1.`, `- [ ]`), bold
 * markers and separators (`→`, `：`, `:`) are removed, nothing is left but `<...>` fragments. A line with any
 * other text (`金额 <100 元时免运费`) or a fragment in backticks is prose or code, not a placeholder.
 */
export function isPlaceholderLine(line: string): boolean {
  const rest = line
    .replace(/^\s*(?:(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?)?/, "")
    .replace(/\*\*/g, "")
    .replace(/[→：:]/g, " ")
    .trim();
  return /^(?:<[^<>`\n]+>\s*)+$/.test(rest);
}

/** Whether any line outside fenced code blocks is a placeholder line. */
export function hasPlaceholderLine(markdown: string): boolean {
  return markdown.replace(/```[\s\S]*?```/g, "").split("\n").some(isPlaceholderLine);
}

/**
 * The initial body of a new document (BR-2037, BR-2055): the project's `canon/templates/<type>.md` when it
 * exists, otherwise the built-in template; a declared type without a template file starts empty.
 */
export function templateFor(type: string, projectTemplates: Readonly<Record<string, string>> = {}, sections: readonly string[] = []): string {
  const own = projectTemplates[type];
  if (own !== undefined) return own;
  switch (type) {
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
      return "## 背景\n\n<为什么需要做这个决定，有哪些事实和数据。>\n\n## 方案\n\n1. <方案一>：<采用或否决，以及理由>\n   - <来源：网址或仓库里的文件路径 “原文摘录”>\n2. <方案二>：<采用或否决，以及理由>\n\n## 决定\n\n<决定了什么。>\n\n## 后果\n\n<带来哪些变化、代价和后续工作。>\n";
    case "change":
      return `## 为什么\n\n<要解决什么问题。>\n\n## 要改什么\n\n<具体改动，以及会新增或修改哪些规则。>\n\n## 陷阱和假设\n\n<新会话接手时最容易踩的坑，以及这个变更依赖的假设；没有就删掉这一节。>\n\n${LESSONS_SECTION}\n\n<每条教训一行：教训 → 现在由哪条规则、检查或命令保证（写编号），或“只靠文字：原因”，或“待负责人确认是否固化”；没有教训就写“无”。>\n\n## 任务\n\n- [ ] <任务>\n`;
    default:
      // A declared type without a template file starts from its required sections (BR-2093).
      return sections.map((s) => `## ${s}\n\n<${s}>\n`).join("\n");
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
