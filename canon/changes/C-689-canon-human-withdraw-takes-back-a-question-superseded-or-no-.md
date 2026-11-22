---
id: C-689
title: canon human withdraw takes back a question superseded or no longer
  needed, so it leaves pending and waiting-owner (#299)
status: open
rules: [BR-2628]
owner_gate: "none: issue 写明了期望的行为"
advances: "none: 修工具缺口"
---

## 为什么

GitHub #299：`canon human` 没法撤回一个没回答、已经被后来的问题取代或不再需要的问题。旧问题一直列在 `canon human pending` 和变更的 `waiting-owner` 里，会话照列表又去问负责人一次（zhushenkongjian 的 `C-1076`：#63、#66 早已由别的问题处理，仍显示在等）。

## 要改什么

- 新命令 `canon human withdraw <n> --reason "<为什么>" [--superseded-by <m>]`（BR-2628）：问题记下撤回理由，事件 `human.withdraw`；worker 不能撤回；已回答、已撤回的拒绝。
- 撤回的问题不再算待回答：`canon human pending`、变更状态的 `waiting-owner`、议程等负责人一组、评审意见等负责人、`approve C-n` 的在等，都按“没回答且没撤回”判断；`pending --all` 照列并写撤回理由；撤回后再回答拒绝。
- 协调数据库 `questions` 表加 `withdrawn` 列。
- humans 领域 README 加业务“待答问题”。

## 教训

无
