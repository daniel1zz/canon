---
id: C-686
title: the stated-fields check runs again in the landing's turn, after the
  rebase (#297)
status: open
rules: [BR-2624]
owner_gate: "none: 修 bug"
advances: "none: 修 bug"
---

## 为什么

GitHub #297：合入前检查新文档有没有缺表态字段（BR-2624）只在排队前跑一次。排队期间如果别的合入给 main 加了 `due: create` 的新字段，这次合入轮到、变基之后不再检查，文档就能缺着这个字段进 main。

## 要改什么

- 合入轮到自己、变基之后的检查步骤（批量合入的每个成员也一样）按那时 main 的声明再查一次，缺的拒绝，原因 `fields`。
- 排队前那一次保留：内容本身决定的拒绝不必等排队。
- BR-2624 写明两次检查，加一个例子。

## 教训

无
