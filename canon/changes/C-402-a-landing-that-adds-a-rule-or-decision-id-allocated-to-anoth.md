---
id: C-402
title: A landing that adds a rule or decision id allocated to another change's
  worktree is refused, naming its holder
status: done
rules:
  - BR-2362
passes:
  BR-2362: 09ce049e52923fd7 test
---

## 为什么

#140：合入的 `canon check` 只看被合入的树，查不出别的变更已经分配、还没合入的编号；`id.allocate` 事件写了没人读。一个变更合入手写的编号，会让真正分配它的变更之后被拒为 `id-duplicate`、只能改号。

## 要改什么

新增 BR-2362：合入新增的规则或决策编号，分配记录在别的 worktree 时拒绝，原因 `check`；分配在自己的 worktree、主 checkout、没有记录都通过。代码在 `src/work/land/checks/allocated.ts`，由 `steps.ts` 在 `canon check` 之后调用；`ChangeInput` 加上变更自己的 worktree（一起测时是成员的 worktree）。

## 陷阱和假设

主 checkout 里分配的编号不算别的变更（#140 的证据：会话在主 checkout 分配后从变更里合入）。

## 教训

无

## 任务

- [ ] 规则、代码、测试
