---
id: C-404
title: The owner's priority recorded with canon backlog urgent takes effect at
  the next turn (#141)
status: open
rules: [BR-2363, BR-2364, BR-2365, BR-2232, BR-2192]
---

## 为什么

issue #141：负责人在 main 的 `canon/backlog.md` 里标优先，main 只通过合入前移，这次编辑本身要在它想插队的队列里排队，优先来得太晚。负责人的决定（canon 问题 #4、#6）：用命令记到协调数据库，立刻生效，不做人工认证（“agent 没必要冒充人，他说是人那肯定是我说的”）。

## 要改什么

新命令 `canon backlog urgent <C-n> --relayed "<原话>"`（`--clear` 撤销）把优先记进新表 `urgent`；`priorityNow` 读它，顺序是修复 main、命令标的、`优先合入`、其余；变更合入（单独或成批）时标记自动删除；`canon work status` 列出标记；`canon brief` 和命令帮助写明只在负责人要求时使用。新规则 BR-2363、BR-2364、BR-2365，BR-2232 改成四级顺序，新决策 D-73（部分修改 D-34，保持 proposed）。

## 陷阱和假设

- 不做任何身份核实（D-73），`--relayed` 只是留痕。
- 停止、放弃的变更的标记不自动清，由负责人 `--clear`。

## 教训

无

## 任务

- [x] 表、命令、priorityNow、合入时清除、status、guide
- [x] 规则、决策、测试
