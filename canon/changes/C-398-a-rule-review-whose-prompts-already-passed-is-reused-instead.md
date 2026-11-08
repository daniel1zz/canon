---
id: C-398
title: A rule review whose prompts already passed is reused instead of rerun
status: open
rules: [BR-2361]
---

## 为什么

#142：每次合入都重跑规则评审，即使它读到的内容和一次已通过的评审完全相同；因冲突、floor 或超时被拒的变更，每次重试都要再付一次。#144 之后预览可能用另一个模型，所以沿用不能跨评审种类。

## 要改什么

- 新规则 BR-2361：键是评审种类、`review` 命令、预算和全部提示的 SHA-256；同种类、同键、通过的评审被沿用，记 `review.reused`；`block` 和另一种类的通过从不沿用；措辞判断没确认的通过不沿用。
- 决策 D-70（proposed）：键的选择和否决的方案。
- 代码：`src/work/land/checks/review-reuse.ts`（键和查找）、`steps.ts`（合入的规则评审）、`src/knowledge/review/preview.ts`（预览，事件多带 hash、规则评审结论和意见）、`src/work/db.ts`（两个按 hash 的部分索引）。
- BR-2358 补一句预览沿用和预览通过不算合入通过。

## 陷阱和假设

- 键含 `review` 命令的文字，不含它调用的脚本的内容（D-70 后果里写明）。
- 重复评审（BR-2143）不沿用。

## 教训

无

## 任务

- [ ] 规则、决策、代码、测试
