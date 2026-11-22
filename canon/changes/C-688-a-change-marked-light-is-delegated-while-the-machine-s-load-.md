---
id: C-688
title: a change marked light is delegated while the machine's load is high
  (memory and slots still checked)
status: done
rules:
  - BR-2627
owner_gate: "none: 负责人在对话里已定方向（标记轻任务），无需再批准"
advances: "none: 调度改进，不属于当前版本的成功标准"
passes:
  BR-2526: c5c1cd2e5d2a1001 test
  BR-2581: 72ca709b826a7ccf test
  BR-2627: ff0d83c86849e496 test
---

## 为什么

负责人 2026-11-22 指出：设计、调研这类任务不跑测试和构建，几乎不占 CPU，却和写代码的变更一样，在机器负载高时派不出去（BR-2526 第 2 条，议程写 busy）。负责人选了“变更上标记为轻任务”：由会话标记，派发时不看负载，内存和名额照查（D-160）。

## 要改什么

- 变更新增可选字段 `cpu_light: "<为什么不跑测试和构建>"`，内置变更类型声明，非空文字（BR-2627）。字段名不用 light：canon 里“light change”已经指杂务的轻量变更记录（BR-2458）。
- `canon work delegate` 对写了它的变更不看负载，跳过的负载超限时输出一行（BR-2526）。
- 议程只因负载没空时，把它列为现在就能派，`--json` 加 `cpu_light_now`（BR-2581）。
- `land --finish` 时它改了 `floor_skip_paths` 以外的路径就提醒标错了（BR-2627）。

## 教训

无
