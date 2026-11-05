# 文档与编号（knowledge/documents）

每个文档是一个带 front matter 的 Markdown 文件。新建文档时分配编号（永远大于已用过的最大编号）、套用中文模板；状态变化（作废、取代、放弃）只改 front matter，文件保留。

## 术语

- **front matter**：文件开头 `---` 之间的 YAML，写编号、标题、状态等。
- **模板占位行**：模板里 `<...>` 形式的行，必须换成真实内容。
- **待办清单**：`canon/backlog.md`，负责人按先后列出的变更编号；没列进的变更排在后面（D-20）。
- **声明的类型**：项目在 `types:` 下声明的文档类型，有自己的编号前缀、目录和状态；内置的规则、决策、变更、笔记不能删除，只能加必填字段。`types:` 的读取和校验、模板的读取在 `src/knowledge/documents/config-keys.ts`。
- **模板**：`canon/templates/<类型名>.md`，新建文档时的初始正文。
