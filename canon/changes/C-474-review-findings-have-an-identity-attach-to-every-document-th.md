---
id: C-474
title: Review findings have an identity, attach to every document they name, and
  close only explicitly (C-464 A)
status: done
rules:
  - BR-2433
  - BR-2434
  - BR-2435
  - BR-2436
  - BR-2437
  - BR-2438
  - BR-2439
plan: C-464
steps:
  - A
passes:
  BR-2433: 9cd96c0ae8ef2166 test
  BR-2434: 2ae57f3e15118a79 test
  BR-2435: 505a4951d1569b99 test
  BR-2436: 38f2877f0c8563cd test
  BR-2437: 1abf3588075ce052 test
  BR-2438: 170e6c695113fce9 test
  BR-2439: c9107230dd3dbcad test
---

## 为什么

C-464 的 A 步。zhushenkongjian 上实测：56 条有结论的拦截意见里真问题 19、误报 32；相邻几轮评审报的是不同的子集和不同的说法（#181），同一对文档上还有方向相反的意见（#183）。D-89 要求意见有身份、只能显式关闭：否则重跑一次评审、恰好没提到一个真问题，它就悄悄消失了；验收（G 步）也要靠这一点要求每条意见都有处置。

## 要改什么

- 新子领域 knowledge/review/findings（`src/knowledge/review/findings`）：意见的身份（BR-2433）、记账（BR-2434）、合入因文档作废而关闭（BR-2435）、`canon context` 显示（BR-2436）、`canon brief` 显示（BR-2437）、`canon verdict record` 判为误报时关闭（BR-2438）、复问后不再成立时关闭（BR-2439，函数 `closeNoLongerHolds` 给 B 步调用）。
- 协调数据库加 `review_findings` 表；`CoordDb.event` 返回事件编号，合入和判定用它记下关闭事件。
- D-97（proposed）：只记点名拦截标准的意见，建议照 D-21 显示和替换；存在独立表里。架构总览写明新数据和代码目录。
- 不在范围内：评审挪到合入之后和核实命令（B）、方向相反的意见（C）、验收（G）；评审是否拦截合入不变。

## 陷阱和假设

- 合入成功时 `land.ok` 里记下的意见今天都是建议（点名标准的意见会让合入被拒），所以 A 合入后 `review_findings` 一直是空的，直到 B 调用 `recordFindings`。这是 D-97 的选择，不是遗漏。
- `canon verdict record` 只能判 `review.block` 里的意见；B 把评审挪到合入之后时，要让判定也能指到那些意见。

## 教训

- 派发说明假设成功合入的评审数据里有拦截类意见，实际上只有建议（BR-2367 让点名标准的意见直接拦截） → 只靠文字：派发说明是自由文字，canon 无法核对其中对现状的描述；做法是动手前读代码核对，写进 D-97 的背景

## 任务

- [x] 身份、记账、显示、三种关闭方式和测试
- [x] D-97、架构总览
