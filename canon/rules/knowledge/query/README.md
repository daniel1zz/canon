---
code:
  - src/knowledge/query.ts
---

# 搜索和上下文（knowledge/query）

agent 怎样找到要读的东西：`canon search` 按词或编号找，`canon context <路径|领域|编号>` 给出相关领域的说明、规则、决策和进行中的变更。路径按领域 README 的代码路径机械对应到覆盖它的子领域，再带上外层领域的说明；规则默认只列标题，`--full` 给全文。代码在 `src/knowledge/query.ts`。

## 术语

- **上下文**：`canon context` 的输出。
- **覆盖**：领域 README 的某个代码路径等于目标，或是目标所在的目录。
