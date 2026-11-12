# 合入（work/land）

`canon work land` 怎样把一个变更安全地变成 main：先排队，一次只有一个合入者；轮到后 rebase 到 main，在这棵树上跑各项检查；全部通过、worktree 期间没变，才用比较并交换移动 main，之后在后台跑 `after_land`。具体行为按子领域分，子领域见 `canon rule domains`；各部件怎么串起来见 `canon/architecture.md`。

这一层只放横跨整个合入流程的规则：git 或文件操作本身失败时以 `environment` 拒绝（BR-2193），它可能发生在关闭提交、rebase、读 main 和移动 main 的任何一步。

不管：评审怎么判断（`knowledge/review`）、检查查什么（`knowledge/check`）、执行记录（`work/execution`）、先合后测时 main 上的后台测试（`work/watch`）。

## 业务

- **入队前的检查**：上次被拒、什么都没变时，合入在入队之前就重跑能当场重跑的检查。
- **连续被拒**：子 agent 的变更连续被拒到三次就停下，交给派它的主 agent 处理，主会话放行后才能再合入（D-99）。

## 术语

- **合入者（lander）**：执行 `canon work land` 的那个进程。
- **队列条目**：一次合入的排队记录，记下合入者的进程和心跳。
- **轮次**：一次只有一个合入者在合入；拿到轮次的合入者 rebase、检查并移动 main。
- **floor**：项目配置的命令，必须在即将成为 main 的代码树上执行成功。
- **--finish**：合入时一起关闭变更并释放自己的认领。
