---
id: C-554
title: "Rule review prompt: a decision line marked as replaced is history, not a
  contradiction; each defect given once"
status: open
rules:
  - BR-2484
---

## 为什么

换成 Codex（gpt-6.1-terra）评审后，6 次评审报了 17 条阻塞意见，最后都按"已修复"结案，但其中有两类浪费：

- 决策按惯例保留当时的原话，再写明已被哪份文档取代；评审把这样的旧原话当成现行要求，D-51 因此被连着修了四轮（#42–#58）。
- 同一个问题换个说法报好几条：一次评审把"D-51 写的默认命令过时"报成 #43、#44、#46、#50 四条。

负责人的要求是：在提示里直接告诉评审。

## 要改什么

新规则 BR-2484：规则评审的提示在"List every blocking defect"那句之后加两句：

- 一段文字写明自己已不再成立，并点名取代它的文档时，只当历史看，不拿被取代的原话报 `contradiction` 或 `restatement`。
- 同一个问题只报一条。

代码在 `src/knowledge/review/review.ts` 的 promptHead；拆成几次调用时，每次调用的提示都有这两句。

## 陷阱和假设

只改提示，canon 不据此过滤回答。拆成几次调用的评审，不同调用之间仍可能重复报同一个问题：每次调用各自作答，合并时只去掉完全相同的文字。

## 教训

- 决策里被取代的句子应在同一行写明"当时……，D-X 起改为……"，不要另起一行加说明 → 能做成机制：canon check 在决策里一行写"不再成立"、却不在被取代的那一行时提示；待负责人确认是否固化。
