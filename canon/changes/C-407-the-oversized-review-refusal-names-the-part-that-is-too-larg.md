---
id: C-407
title: The oversized-review refusal names the part that is too large and a
  remedy that fits it
status: done
rules:
  - BR-2359
passes:
  BR-2359: e70ebf0a36737c01 test
---

## 为什么

#136：规则评审的提示太大时，拒绝信息总是说“把改动拆成几次合入”，只有改动文档是大头时才有用；固定的规则索引加决策标题、或某个领域的 README、某条大规则才是大头时，拆变更没有用。

## 要改什么

- `reviewPrompts` 的拒绝信息写出三部分的大小（改动文档；评审说明加索引加决策标题；领域的那一块），按哪块大给补救办法：改动文档最大且剩下的放得进 → 拆变更（和现在一样）；否则说拆变更没有用，给调大 `review_max_prompt_kb`，领域的那一块是原因时再加 `canon rule domain` 拆子领域。
- BR-2359 的文字和例子；D-67 的一行事实更正（信息写什么），决定本身不变；负责人对“改动文档超过预算仍拒绝”的确认（2026-11-08）不变。
- 测试：`src/knowledge/review/budget.test.ts`。

## 陷阱和假设

“最大的部分”按字节比较改动文档、评审说明加索引加标题、领域那一块；改动文档里算上总览和措辞判断（它们随改动文档一起进每次调用）。

## 教训

无

## 任务

- [ ] 规则、代码、测试
