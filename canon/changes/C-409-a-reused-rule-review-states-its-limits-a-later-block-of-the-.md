---
id: C-409
title: A reused rule review states its limits, a later block of the same prompts
  wins, and D-70 and D-73 are accepted
status: open
rules: [BR-2361]
---

## 为什么

对 D-70 的独立挑战（来自 #142 的 C-398）：键不含评审命令的环境和脚本内容，限制没有写明；同一份提示后来的 block 不盖过更早的通过；BR-2361 有几个例子没有测试；两条路径的 `review.reused` 字段不一致。D-70 和 D-73 还是 proposed，负责人已审，要接受。

## 要改什么

- BR-2361 和 D-70 后果：写明键不含环境变量、工作目录和脚本内容，改命令文字（加版本参数）可强制重评；不把环境放进键。
- 同一份提示的最新结论决定：后来的 `block` 盖过更早的通过（`passedReview` 看 `review.ok` 和 `review.block` 里最新的一条；索引改成覆盖两种事件）。
- `review.reused` 的字段：合入的是 review、docs、hash、from、commit，预览的是 review、docs、hash、from、tree，两种都列在 BR-2361。
- 测试补齐：拆开的评审（第一次过、第二次 block，不沿用；全过才沿用）、合入通过后预览照常评审、BR-2239 答 behaviour 后重评、命令或预算变了（经合入路径）、后来的 block、沿用的输出行。
- 接受 D-70 和 D-73（负责人已审，D-73 是负责人的明确选择，问题 #6）。

## 陷阱和假设

旧数据库里 `events_review_hash` 只覆盖 `review.ok`，启动时删掉，换成 `events_review_verdict_hash`。

## 教训

无

## 任务

- [ ] 规则、代码、测试、接受决策
