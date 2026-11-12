# 工作流（work）

多个会话同时干活时怎样不丢工作：一个变更对应一个 worktree、一个认领，main 只有通过合入才前移，所有协调状态放在 git 公共目录下的协调数据库里。部件怎么连、数据存在哪，见 `canon/architecture.md`；怎样合入见 `work/land`。

这一层只放贯穿整个领域的规则（谁做的、每次拒绝都记下、数据库升级）。具体行为按子领域分，子领域见 `canon rule domains`。

## 术语

- **认领（claim）**：一个变更的租约，由一个 worktree 和一个执行者持有。
- **执行者（actor）**：做这件事的会话或人，`CANON_ACTOR`；Claude Code 里是会话 id，同一个会话的子 agent 共用它，靠 worktree 分开（D-18）。
- **floor**：项目配置的命令，必须在即将成为 main 的代码树上执行成功（`canon/config.yaml`）。
- **合入（land）**：rebase 到 main、跑 floor、跑检查、移动 main；规则评审在合入之后（knowledge/review）。
- **handoff**：会话停下时记下的下一步。
- **事件表**：协调数据库里的 `events`，记下每次写入和拒绝，`canon stats` 从它算。
