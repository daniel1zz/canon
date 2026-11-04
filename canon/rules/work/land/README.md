# 合入（work/land）

`canon work land` 怎样把一个变更安全地变成 main：先排队，一次只有一个合入者；轮到后 rebase 到 main，在这棵树上跑各项检查；全部通过、worktree 期间没变，才用比较并交换移动 main，之后在后台跑 `after_land`。具体行为按子领域分：

- `work/land/checks`：合入的检查，什么情况下合入被拒（未提交的改动、floor、rebase 冲突、`canon check`、合入过程中 worktree 变了、同一次合入里新增并使用配置键或检查名等），以及什么时候不跑 floor。
- `work/land/queue`：排队和轮次：谁先轮到、等多久、合入者掉线或被终止时轮次怎样让出、排队时预测冲突、冲突后保留位置。
- `work/land/batch`：一起测（D-26）：轮到的合入者把紧跟在后面的几个合入一起测、只跑一次 floor，没整体通过时退回各自单独合入。
- `work/land/finish`：移动 main 和收尾：比较并交换移动 main、`--finish` 关闭变更和撤回关闭提交、`after_land`。

这一层只放横跨整个合入流程的规则：git 或文件操作本身失败时以 `environment` 拒绝（BR-2193），它可能发生在关闭提交、rebase、读 main 和移动 main 的任何一步。

不管：评审怎么判断（`knowledge/review`）、检查查什么（`knowledge/check`）、执行记录（`work/execution`）、先合后测时 main 上的后台测试（`work/watch`）。

## 术语

- **合入者（lander）**：执行 `canon work land` 的那个进程。
- **队列条目**：一次合入的排队记录，记下合入者的进程和心跳。
- **轮次**：一次只有一个合入者在合入；拿到轮次的合入者 rebase、检查并移动 main。
- **floor**：项目配置的命令，必须在即将成为 main 的代码树上执行成功。
- **--finish**：合入时一起关闭变更并释放自己的认领。
