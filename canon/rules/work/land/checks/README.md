# 合入的检查（work/land/checks）

一次合入在哪些情况下被拒、main 不动：合入前（不在变更分支上、没有 floor、有未提交的改动）；轮到之后（排队期间出现的未提交改动、rebase 冲突、同一次合入里新增并使用配置键或检查名、`canon check` 有发现、措辞判断不确认（BR-2239）、`before_land` 失败、floor 失败，按这个顺序，floor 最后（BR-2014，和一起测相同）；合入过程中 worktree 变了）；以及只改了 `floor_skip_paths` 下文件时不跑 floor；还有不拒绝的提示：合入新增了仍是 `proposed` 的决策（BR-2355）。每种拒绝都有自己的原因，`canon stats` 按原因统计（BR-2067）。

不管：检查本身查什么（`canon check` 的各项发现在 `knowledge/check`，规则评审在 `knowledge/review`，执行记录在 `work/execution`）；排队时预测到冲突就拒绝（BR-2153）属于 `work/land/queue`，因为它发生在等轮次时、结束的是等待；比较并交换时 main 已经变了（BR-2017）属于 `work/land/finish`；关闭变更前要写好教训（BR-2161）也属于 `work/land/finish`，它是关闭变更的要求。

rebase 冲突（BR-2015）放在这里，因为它是轮到之后的一次拒绝；冲突被拒后保留排队位置的部分在 `work/land/queue`（BR-2177）。

## 业务

- **合入的前提**：合入前就能判定的拒绝：不在变更分支上、没有配置 floor、worktree 有未提交的改动（排队期间才出现的也算）。
- **合入的步骤**：轮到之后到移动 main 之前依次做哪些检查、哪一步拒绝时后面的不再做，以及不拒绝只提示的那几项。
- **rebase 冲突**：rebase 到 main 冲突时拒绝合入，工作原样保留。
- **canon check 的拒绝**：`canon check` 有发现时拒绝合入，事件里记下发现的种类和文件。
- **新增的编号和配置键**：这次合入新增的规则或决策编号、配置键和检查名，和别的变更或还没更新的 canon 撞上时拒绝。
- **floor 跑多少**：跳过 floor 和只跑一项范围命令的条件，以及哪些文件不许被跳过。
- **测试报告**：floor 写出的 JUnit 报告怎样记进协调数据库，rebase 带进来的测试文件怎样补一次报告。
- **密钥扫描**：合入在移动 main 之前找变更里提交的密钥明文。

## 术语

- **被合入的树**：rebase 到 main 之后的那棵代码树，`canon check`、措辞判断、`before_land` 和 floor 都在它上面跑，只有它能成为 main（BR-2106）；合入后的评审评审的也是它。
- **每个变更自己的步骤**：配置键核对、`canon check`、执行记录、来源核对、措辞判断、`before_land`；都在 floor 之前跑；规则评审和重复评审不在其中，合入之后运行（BR-2441）（BR-2014），单独合入和一起测的顺序相同，一起测时每个成员各跑一次。
- **跳过 floor**：合入只改了项目声明的 `floor_skip_paths` 下的文件，代码树和 main 上已测过的一样，不跑 floor（BR-2164）。
