---
code:
  - src/knowledge
  - src/check
  - src/review
  - scripts
---
# 知识（knowledge）

`canon/` 下长期保存的文档，以及让它们保持真实的检查：文件格式、编号分配、搜索、上下文、`canon check`，对规则、决策文字的 AI 评审，以及合入后的代码评审脚本（`scripts/code-review.ts`，默认不开启）。

## 术语

- **规则**：产品现在必须怎么工作的一条陈述，存为 `canon/rules/<领域>/BR-n.md`。
- **领域**：一个规则目录，加一个 README，写明它管哪些代码目录。
- **决策**：一个重要选择当初为什么这么定，编号 `D-n`。
- **变更**：一项要做的工作，编号 `C-n`。
- **笔记**：调研、复盘、参考资料，编号 `N-n`。
