---
code:
  - src/knowledge
  - src/check
  - src/review
  - scripts
---

# 知识（knowledge）

`canon/` 下长期保存的文档，以及让它们保持真实的检查。按子领域分：

- `knowledge/documents`：文档的格式、编号、模板、状态变化。
- `knowledge/check`：`canon check` 的各项检查。
- `knowledge/query`：搜索和 `canon context`。
- `knowledge/review`：合入时对规则、决策文字的 AI 评审，以及合入后的代码评审脚本。

## 术语

- **规则**：产品现在必须怎么工作的一条陈述，存为 `canon/rules/<领域>/BR-n.md`。
- **领域**：一个规则目录，加一个 README，写明这一块业务管什么；可以有子领域（子目录），子领域也有自己的 README，只写业务，不写代码位置。代码位置按约定（配置了 `code_root` 时，`<code_root>/<领域路径>` 和领域一一对应）或由顶层领域 README 的 `code:` 给出（D-15）。
- **决策**：一个重要选择当初为什么这么定，编号 `D-n`。
- **变更**：一项要做的工作，编号 `C-n`。
- **笔记**：调研、复盘、参考资料，编号 `N-n`。
