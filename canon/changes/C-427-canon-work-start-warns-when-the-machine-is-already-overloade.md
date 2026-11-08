---
id: C-427
title: canon work start warns when the machine is already overloaded by the work
  in progress (#155)
status: open
rules: []
---

## 为什么

#155：zhushenkongjian 在一台 8 核机器上同时有约 17 个 worker 认领变更，负载在 40 到 100 之间持续几个小时。附近跑 `canon work test` 多的时候 floor 中位数 10.4 分钟，少的时候 6.1 分钟（96 次 floor，相关性，不是对照实验）；队列每小时只合入约 4 个，`land.turn` 中位等待 65 分钟，又带来冲突和测试报告过期（#152）。`canon work start` 不看机器的负载，开多少都放行。

## 要改什么

- `canon work start` 开一个新变更时（不含 `--fix-main`，不含接回自己认领的变更），机器 5 分钟平均负载达到 CPU 数（`availableParallelism`）的 2 倍时，照常开工，但在输出里提示一行：负载多少、几个 CPU、现在有几个认领、最近 floor 的中位时长和负载低时的中位时长（canon 已经记了 floor 的运行），并建议等负载降下来或先合入已有的变更。退出码不变。
- 新规则（`work/session`），例子写负载刚好在线上和线下、`--fix-main` 不提示、读不到负载（平台不支持）时不提示也不报错。
- 不做：拒绝开工或排队等待（会挡住修复和负责人要的活，要做先写决策并问负责人）；按项目配置改阈值（先看提示有没有用，`canon stats` 能数提示次数之后再说）。
