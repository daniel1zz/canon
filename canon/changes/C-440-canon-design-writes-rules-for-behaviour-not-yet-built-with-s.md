---
id: C-440
title: canon-design writes rules for behaviour not yet built with status planned
  (#168)
status: open
rules: []
---

## 为什么

#168：canon-design skill 让设计阶段为设计承诺的每个行为写规则，还说“每条生效的规则都要有测试”，却没提规划中（`planned`）的状态。于是代码要等后面步骤才写的设计变更，规则一写就是生效状态，没有测试就合不进去；评审又每轮从例子里找出新的边界。BR-2235 和 D-32 早就为这种情况准备了 `planned`：要有规则和例子，不要求测试，由实现它的变更改成生效。

负责人 2026-11-09 定了（canon human #9，“先写成 planned（推荐）”）：保持 D-32 先设计、先写全 baseline 的做法，在 skill 里写明用 `planned`；评审每轮都提出新边界的问题由 #154、#165 的变更（C-435、C-436）处理。

## 要改什么

- canon-design 的“记录设计”一步：这次变更不实现的行为，规则用 `status: planned`；只要规则和例子、不要测试；实现它的变更在 `rules:` 里列出它并改成生效。规划中规则的例子只写设计定下来的边界，实现时发现的边界由实现那一步补。
- 只改 skill 文字，不改任何规则的含义。

不做：不改 D-32；不改评审怎么处理规划中的规则。

## 教训

无

## 任务

- [x] 改 canon-design skill
