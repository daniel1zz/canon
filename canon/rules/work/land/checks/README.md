# 合入的检查（work/land/checks）

一次合入在哪些情况下被拒、main 不动：合入前（不在变更分支上、没有 floor、有未提交的改动）；轮到之后（排队期间出现的未提交改动、rebase 冲突、floor 失败、同一次合入里新增并使用配置键或检查名、`canon check` 有发现、合入过程中 worktree 变了）；以及只改了 `floor_skip_paths` 下文件时不跑 floor；还有不拒绝的提示：合入新增了仍是 `proposed` 的决策（BR-2355）。每种拒绝都有自己的原因，`canon stats` 按原因统计（BR-2067）。

不管：检查本身查什么（`canon check` 的各项发现在 `knowledge/check`，规则评审在 `knowledge/review`，执行记录在 `work/execution`）；排队时预测到冲突就拒绝（BR-2153）属于 `work/land/queue`，因为它发生在等轮次时、结束的是等待；比较并交换时 main 已经变了（BR-2017）属于 `work/land/finish`；关闭变更前要写好教训（BR-2161）也属于 `work/land/finish`，它是关闭变更的要求。

rebase 冲突（BR-2015）放在这里，因为它是轮到之后的一次拒绝；冲突被拒后保留排队位置的部分在 `work/land/queue`（BR-2177）。

## 术语

- **被合入的树**：rebase 到 main 之后的那棵代码树，floor、`canon check`、评审和 `before_land` 都在它上面跑，只有它能成为 main（BR-2106）。
- **每个变更自己的步骤**：`canon check`、执行记录、来源核对、规则评审、`before_land`；一起测时每个成员各跑一次。
- **跳过 floor**：合入只改了项目声明的 `floor_skip_paths` 下的文件，代码树和 main 上已测过的一样，不跑 floor（BR-2164）。
