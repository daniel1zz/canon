# 工作流（work）

多个会话同时干活时怎样不丢工作：一个变更对应一个 worktree、一个认领；合入一次只进行一个，按排队顺序；只有 floor 和 `canon check` 在即将成为 main 的那棵代码树上通过后，main 才会通过比较并交换前移（只改了项目声明的 `floor_skip_paths` 下文件时代码树和 main 一样，不跑 floor；项目设了 `floor_timing: after` 时合入不跑 floor，main 前移后在后台测试，见 `work/watch`）。所有协调状态（认领、合入队列、交接记录、问题、事件）存在 git 公共目录下的协调数据库里，所有 worktree 共用。

这一层只放贯穿整个领域的规则（谁做的、每次拒绝都记下、数据库升级）。具体行为按子领域分：

- `work/session`：变更的开始、停下、交接、清理 worktree，会话开始时的 `canon brief`。
- `work/claims`：认领，以及靠进程判断持有者是否还在。
- `work/land`：合入：排队、rebase、floor、检查、评审、移动 main。
- `work/drop`：放弃变更，会丢的东西先存档。
- `work/humans`：留给人的问题。
- `work/stats`：每个检查的运行和拒绝统计。
- `work/issues`：列出项目开着的 GitHub issue，标出 main 上已写明修复的。
- `work/verify`：合入前的验证，`canon work test`。
- `work/execution`：规则的执行记录：变更合入时每条执行的规则要有证据，规则的执行状态由行为哈希和通过记录算出。
- `work/hooks`：项目配置的生命周期 hook 命令和每个变更的端口 `CANON_PORT`，`canon work after-land`。
- `work/remote`：合入后把 main 推到项目配置的远端，`canon sync` 能快进时拉下来。
- `work/snapshots`：每次 Bash 调用前把未提交的工作存成快照，弄丢后能找回。
- `work/watch`：先合后测（`floor_timing: after`）：main 上的后台测试、main 没通过时的记录和修复变更。

## 术语

- **认领（claim）**：一个变更的租约，由一个 worktree 和一个执行者持有。
- **执行者（actor）**：做这件事的会话或人，`CANON_ACTOR`；Claude Code 里是会话 id，同一个会话的子 agent 共用它，靠 worktree 分开（D-18）。
- **floor**：项目配置的命令，必须在即将成为 main 的代码树上执行成功（`canon/config.yaml`）。
- **合入（land）**：rebase 到 main、跑 floor、跑检查、规则评审、移动 main。
- **handoff**：会话停下时记下的下一步。
- **事件表**：协调数据库里的 `events`，记下每次写入和拒绝，`canon stats` 从它算。
