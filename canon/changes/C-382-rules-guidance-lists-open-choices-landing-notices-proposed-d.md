---
id: C-382
title: Rules guidance lists open choices; landing notices proposed decisions
status: open
rules: []
---

## 为什么

Fixes #129。写规则时没有一步要求列出规则和范围留下的开放选择（触发方式、范围里的“或”、仍是 proposed 的决策），这些选择到实现时才冒出来，打断负责人放手让它跑的工作。

## 要改什么

- canon-rules skill：第 2 节加一行“What triggers it, observably?”；第 5 节把负责人的（产品手感、用的时候能注意到的一切）和 agent 的分清；新增 5a“列出开放选择并逐个定下来”。
- `canon work land` 合入新增了仍是 proposed 的决策时，打印提示并记 `land.proposed` 事件，不拒绝（因为子 agent 按设计把决策合成 proposed）。新规则 BR-2355（work/land/checks）。
- 不检查范围文字里的“或”：那是解析特定语言的文字，只放在 skill 里。

## 陷阱和假设

<新会话接手时最容易踩的坑，以及这个变更依赖的假设；没有就删掉这一节。>

## 教训

无

## 任务

- [x] BR-2355 和测试
- [x] 合入时提示
- [x] canon-rules skill
