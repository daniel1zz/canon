---
id: C-687
title: implicit delegation refuses a change claimed after its eligibility was
  checked (#294)
status: open
rules: [BR-2610]
owner_gate: "none: 修 bug"
advances: "none: 修 bug"
---

## 为什么

GitHub #294：子 agent 开工时，canon 先判断能不能替主会话做一次隐式派发（BR-2610，在事务外），再在事务里写入派发。两步之间主会话正好认领了这个变更时，事务里不再看认领，照样写入派发，还会删掉主会话的认领：变更被交给了子 agent。

## 要改什么

- 隐式派发在写入派发的事务里再查一次活着的认领，有就按冲突拒绝（退出码 5），不写派发、不动认领，记 `delegation.refuse`。
- BR-2610 写明这一条，加一个例子。

## 教训

无
