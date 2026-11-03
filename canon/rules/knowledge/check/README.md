---
code:
  - src/check
---

# 检查（knowledge/check）

`canon check` 检查整个 `canon/` 是否自洽：文件格式、编号唯一、引用存在、领域 README 的代码路径存在、规则有测试在标题里点名、必填段落非空、没有残留的模板占位行。合入时也会跑它（`work/land`）。代码在 `src/check`。

## 术语

- **发现（finding）**：一条检查结果，带种类（如 `ref-dangling`）、文件和说明。
- **测试标题**：`test`、`it`、`describe` 的第一个参数；只有会运行的测试标题里的规则编号才算这条规则有测试。
