---
code:
  - src/work/drop.ts
---

# 放弃变更（work/drop）

`canon work drop C-n` 删除一个不再做的变更的 worktree 和分支。不会丢东西时直接删；会丢东西时（未合入的提交、未提交和未跟踪的文件、不能重新生成的被忽略文件），先存档到 `refs/canon/archive/<C-n>/<时间>`，读回校验后才删，并打印恢复命令，不问人（D-13）。代码在 `src/work/drop.ts`。

## 术语

- **存档 ref**：保存被删内容的提交，父提交是分支最新提交。
- **可重新生成**：配置 `regenerable` 里列出的被忽略目录或文件（如 `node_modules`、`dist`），删除时不算丢东西。
