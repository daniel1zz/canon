---
id: C-509
title: canon work test names the rules a landing would refuse for missing
  evidence, instead of only the landing turn
status: open
rules:
  - BR-2456
---

## 为什么

C-494 合入时被拒了一次 `evidence`：改了三条规则的例子却没有对应的测试证据。这件事在 worktree 里就算得出来（预览评审已经算出关闭时的执行记录），可 `canon work test` 和 `canon check` 都说 ok，要等排到队才报，每次多一轮排队和测试。负责人选了先修这一处（canon human #35 选 A）。

## 要改什么

- BR-2456：`canon work test` 在 `canon check` 之后按合入的同一套算法列出缺证据的规则，有就算失败。
- `src/work/verify/verify.ts` 调 `planClose`，`work.test` 事件记 `evidence` 条数。

## 教训

- 合入在队里才报的确定检查，worktree 里也应该能报 → 本变更为执行证据做到了（BR-2456）；别的只在队里才跑的确定检查还没逐一核对，只靠文字：要一项项看。

## 任务

- [x] 规则、代码、测试
