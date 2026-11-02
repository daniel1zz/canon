---
code:
  - src/work
  - src/coord
  - src/app
  - src/repo
---
# 工作流（work）

多个会话同时干活时怎样不丢工作：一个变更对应一个 worktree、一个认领；合入一次只进行一个，按排队顺序；只有 floor 和 `canon check` 在即将成为 main 的那棵代码树上通过后，main 才会通过比较并交换前移。

## 术语

- **认领（claim）**：一个变更的租约，由一个 worktree 持有。
- **floor**：项目配置的命令，必须在即将成为 main 的代码树上执行成功（`canon/config.yaml`）。
- **合入（land）**：rebase 到 main、跑 floor、跑检查、规则评审、移动 main。
- **handoff**：会话停下时记下的下一步。
