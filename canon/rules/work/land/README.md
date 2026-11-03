# 合入（work/land）

`canon work land` 怎样把一个变更安全地变成 main：先排队，一次只有一个合入者；轮到后 rebase 到 main，在这棵树上跑 floor、`canon check`、规则评审和 `before_land`；全部通过、worktree 期间没变，才用比较并交换移动 main（只改了项目声明的 `floor_skip_paths` 下文件的合入不跑 floor）；之后在后台跑 `after_land`。合入者进程不在了或被信号终止，它的轮次立刻让出。

不管：评审怎么判断（`knowledge/review`）、检查查什么（`knowledge/check`）。

## 术语

- **队列条目**：一次合入的排队记录，记下合入者的进程和心跳。
- **心跳**：合入者拿到轮次后定期更新的时间，停止更新的合入者会被跳过。
- **比较并交换**：只有 main 仍是 rebase 时的那个提交，才把它移到新提交。
- **--finish**：合入时一起关闭变更并释放自己的认领。
