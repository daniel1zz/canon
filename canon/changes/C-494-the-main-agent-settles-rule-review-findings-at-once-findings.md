---
id: C-494
title: "The main agent settles rule-review findings at once: findings are pushed
  to it, it closes them with a quoted reason or a fix, no separate verify or
  re-ask"
status: open
rules:
  - BR-2442
  - BR-2453
  - BR-2451
---

## 为什么

负责人（canon human #31、#34）要求主 agent 当场处理合入后评审的拦截意见，不再另跑核实命令、不再逐条复问；现在主 agent 关不掉任何意见（BR-2254 不让 agent 用 `canon verdict record`），意见一直挂着。决策见 D-99，这是它的意见那一半。

## 要改什么

- D-99（proposed）写下决定；连续三次被拒那一半在之后的变更做。
- BR-2442 改写：拦截意见不再核实，全部记成未处理的意见，日志指向 `canon finding close`；作废 BR-2450（复问）；去掉配置项 `review_verify`（没有项目配过）。
- 新规则：`canon finding close <#n> --fixed <提交> | --spurious "<原文>" --reason "<理由>"`，agent 和人都可用；`--fixed` 的提交在 main 上且改过意见点名的文档，`--spurious` 的原文逐字在意见点名的某份文档里。
- `canon work after-land` 列出这次记下的意见和关闭命令。
- 代码：`src/knowledge/review/landed.ts` 去掉 verifyOne、reask；`src/knowledge/review/findings` 加关闭命令；`config-keys.ts` 去掉 review_verify；`canon/architecture.md` 第 15、67、68、69、89 行改写。

## 教训

无

## 任务

- [x] D-99
- [x] 规则改写和新规则
- [x] 代码和测试
- [x] 架构总览
