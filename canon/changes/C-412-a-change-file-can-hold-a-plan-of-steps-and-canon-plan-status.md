---
id: C-412
title: A change file can hold a plan of steps, and canon plan status shows each
  step done, working, ready or blocked
status: done
rules:
  - BR-2369
  - BR-2370
  - BR-2371
  - BR-2372
  - BR-2373
  - BR-2374
  - BR-2376
passes:
  BR-2369: 2ebc5de1f10a778d test
  BR-2370: 79638451a447d979 test
  BR-2371: 45cca4a565cdbd9f test
  BR-2372: 6b5e81a3776c6b31 test
  BR-2373: 16a87997ee8015df test
  BR-2374: e6d64825142e7caf test
  BR-2376: 9194551b905a4cf1 test
---

## 为什么

#146（负责人提）：规则按步骤边做边写、不事先登记的项目，`canon release status` 显示“规划中 0 已通过 378”，读起来像做完了，实际计划只做了约 41% 和 57%。真正的计划在变更文件里（一种是带“依赖”列的步骤表，一种是“第 N 步”标题加“依赖”行），canon 读不出；项目自己写了按标题对变更的脚本，手工看又漏过一个依赖早已合入、却几个小时没人派的步骤。已在 #146 里用一个临时仓库复现：`canon release status` 全是 0，`canon check` 对步骤表没有任何反应。

现有概念都不管这件事：版本数规则不数步骤，规划中的规则要事先登记，待办顺序没有依赖。决策 D-77（proposed）比较了六种做法，选了“计划写在变更文件的步骤表里，变更用编号指明自己做哪几步，进度由变更状态算出”。

这件事比一个变更大，按竖切片拆：

1. 本变更（第一片）：格式、检查、状态、`canon plan status`、开工时写联系。
2. `canon brief` 和 `canon change list` 提示可开始的步骤，协调者一开会话就看到该派谁（#146 的“漏派”）。
3. 计划标上版本，`canon release status` 同时显示计划进度（#146 的“读起来像做完了”）。
4. 把已有的两种写法迁到这个格式的办法（给 zhushenkongjian 那样的项目）。

第 2 到第 4 片都是 agent 能独立做完的，不需要先问人；第 2 片依赖本变更先合入。

## 要改什么

- 计划的格式（BR-2369、BR-2370）：变更文件的 `## 计划` 节是一张表，列 `步骤`、`内容`、`依赖`；写错、重名、依赖不存在、成环都由 `canon check` 报 `file-invalid`。
- 变更与步骤的联系（BR-2371）：front matter 的 `plan: C-n` 加 `steps: [...]`；指向不存在的计划或步骤报 `ref-dangling`。`plan`、`steps` 加进保留的 front matter 键。
- 步骤状态（BR-2372）：已完成 / 进行中 / 可开始 / 被挡住，每次从变更算，不存；只在自己分支上的变更算进行中。
- `canon plan status [C-n] [--json]`（BR-2373、BR-2374）：一行一个计划，或一个计划按状态列步骤，可开始的步骤带内容。
- `canon work start --title … --plan C-n --step 名`（BR-2376）：把联系写进新变更，开工前检查计划和步骤，被拒绝的不留编号和 worktree。
- 同步：`canon/architecture.md`、`canon-triage` skill 里“大工作拆成竖切片”一段、新的领域 `knowledge/plans`。

不做（后面几片或不做）：`canon brief` 和 `canon change list` 提示可开始的步骤；计划属于版本、`canon release status` 显示计划；已有格式的迁移；`canon work start` 自动挑一个可开始的步骤；按标题或散文猜计划；把计划状态存进文件或数据库；计划当独立的文档类型。

## 陷阱和假设

- `steps: [3.10]` 不加引号时 YAML 读成 3.1：只接受整数和字符串，小数一律要求加引号，报错而不是悄悄读错（BR-2371）。
- 进行中的步骤只有做它的变更写了 `plan`、`steps` 才看得见；`--plan --step` 就是为了不靠手写。
- 计划变更必须已合入 main 才有计划；做步骤的变更还在自己分支上也算（用 `canon change list` 同一套读分支的办法）。
- 决策 D-77 是 proposed，没有接受；它也记着“独立文档类型”现在不做的理由。

## 教训

无

## 任务

- [x] 复现并在 #146 留下命令和输出
- [x] 决策 D-77（六种做法，proposed）
- [x] 规则 BR-2369 到 BR-2374、BR-2376，每条都有点名它的测试
- [x] 读取、检查、状态、`canon plan status`、`canon work start --plan --step`
- [x] 更新 architecture.md 和 canon-triage skill
- [ ] 第 2 到第 4 片写成变更并释放
