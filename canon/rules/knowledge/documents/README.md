---
code:
  - src/knowledge/read.ts
  - src/knowledge/write.ts
  - src/knowledge/templates.ts
  - src/knowledge/docfile.ts
  - src/knowledge/model.ts
  - src/knowledge/types.ts
---

# 文档与编号（knowledge/documents）

每个文档是一个带 front matter 的 Markdown 文件。新建文档时分配编号（永远大于已用过的最大编号）、套用中文模板；状态变化（作废、取代、放弃）只改 front matter，文件保留。代码在 `src/knowledge/read.ts`（读）、`write.ts`（写）、`templates.ts`、`docfile.ts`、`model.ts`、`types.ts`（文档类型）。

## 术语

- **front matter**：文件开头 `---` 之间的 YAML，写编号、标题、状态等。
- **模板占位行**：模板里 `<...>` 形式的行，必须换成真实内容。
