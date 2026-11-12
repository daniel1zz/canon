---
id: C-479
title: "Step B, second half: a review after landing splits changed documents
  that do not fit, a failed one can be queued again, open findings are re-asked,
  verdict and stats cover the review after landing"
status: done
rules:
  - BR-2448
  - BR-2449
  - BR-2450
  - BR-2451
  - BR-2359
  - BR-2375
  - BR-2439
  - BR-2253
  - BR-2397
plan: C-464
steps:
  - B
passes:
  BR-2253: 87eeb8f4413525ff test
  BR-2359: c23d3fdacc7a4cda test
  BR-2375: 01f95c5a0478abcc test
  BR-2397: 491bef642f30d96e test
  BR-2439: 8bd3e74154d1dffc test
  BR-2448: 432c6fe061c13d4d test
  BR-2449: 531564d29b611841 test
  BR-2450: d411ebf756487eb9 test
  BR-2451: 06477752e3cc6a00 test
---

## 为什么

C-464 的 B 步后一半。前一半 C-475 已经把规则评审和重复评审挪到合入之后，但它自己的合入后评审没跑成：改动文档 255 KB，加上评审说明和规则索引 57 KB，超过 300 KB 的预算，而 BR-2359 只会按子领域拆领域全文，拆不了改动文档；失败的合入后评审也不会重试，于是 C-475 的规则和决策改动在 main 上一直没有评审（负责人选 A，见 C-475 的合入记录和 canon human #29 之后的协调消息）。另外 D-89 要求的复问、对合入后评审意见的判定和按标准的核实统计还没接上。

## 要改什么

- 合入后的评审和预览评审在改动文档放不进一次调用时按文档分成几部分（BR-2448，新），每部分列出其余改动文档的编号、标题和第一行；规则写明会漏掉什么：分在不同部分的文档之间从这一行看不出来的矛盾。BR-2359、BR-2375 跟着改。
- `canon work review-landed --again <C-n>` 为一个变更最近一次合入重新排上失败或没有的合入后评审（BR-2449，新）。
- 合入后评审跑完之后逐条复问挂在被评审文档上的未处理意见，答不成立的按 BR-2439 关闭（BR-2450，新）。
- `canon verdict` 能判定合入后评审的拦截（BR-2253）；`canon stats` 按拦截标准数核实成立、被否定和没核实的意见（BR-2451，新），评审次数那一行改叫 `rule reviews after landing`（BR-2397）。
- `review_max_prompt_kb` 改回默认的 250（去掉 canon human #28 临时调大的那两行）。

## 陷阱和假设

- C-475 的评审要等这里合入、`dist/canon` 从绿的 main 重新发布之后，用 `canon work review-landed --again C-475` 重新排；评审读的是 C-475 合入前 main 上的设置（预算 300 KB），代码是新版的。
- 分部分的估算用 BR-2375 同一套大小：每部分最小的一次（说明、这部分的改动文档、规则索引、它受影响领域里最大的一块）不超过预算才放进去；真正的提示仍由 BR-2359 的装箱算，所以估算只能偏大。

## 教训

- 合入后评审只要失败一次，那次合入的文档就一直没有评审，没有任何东西提醒 → 现在由 BR-2449 的命令补跑；有没有评审过仍要等验收（D-89）检查。

## 任务

- [x] rebase 到 C-475 合入后的 main，去掉 C-475 已经带上的文档改动
- [x] 改动文档分部分评审（BR-2448），BR-2359、BR-2375 跟着改
- [x] `canon work review-landed --again`（BR-2449）
- [x] 复问未处理的意见（BR-2450）
- [x] `canon verdict` 判定合入后评审的拦截（BR-2253），`canon stats` 按标准统计（BR-2451、BR-2397）
- [x] `review_max_prompt_kb` 改回 250
- [ ] 测试、`canon work test`、合入
