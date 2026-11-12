---
id: C-492
title: BR-2452 points to BR-2084 for the update-check line instead of restating it
status: done
rules:
  - BR-2452
passes:
  BR-2452: 4b06e2134a0de49f test wording
---

## 为什么

C-491 合入后的规则评审记下一条拦截意见（#3，没有核实命令，按成立处理）：BR-2452 的规则段把 BR-2084 已写明的过期项输出（`config canon/config.yaml: links_since missing …`）和触发条件又写了一遍。

## 要改什么

- BR-2452 的规则段只写“项目算过期，按 BR-2084 列出、按 BR-2085 提示”，输出的写法只留在 BR-2084；例子不变，行为不变。

## 教训

无

## 任务

- [x] 改 BR-2452 的规则段
