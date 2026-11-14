---
id: C-556
title: "Landed reviews: up to landed_review_parallel queued reviews run at once,
  sharing one call budget; reviews of overlapping documents keep queue order
  (#220)"
status: done
rules:
  - BR-2487
  - BR-2441
passes:
  BR-2441: c42c9331b02c65a6 test
  BR-2487: 115429bb6a669ccb test
---

## 为什么

#220：合入后的评审由后台评审进程一次只跑一个。worker 并行合入或批量 `--again` 重跑时，评审排成长队：2026-11-14 有两组各 5 次评审一个接一个地跑，每次 1 到 2 分钟。

## 要改什么

新规则 BR-2487 和决策 D-121（修改 D-89），BR-2441 改为按 BR-2487：

- 仍只有一个评审进程，它最多同时跑 `landed_review_parallel` 个评审，默认 1。
- 所有评审的调用共用 `review_parallel` 的名额（`review.ts` 的 `Slots`）。
- 改了同一个 `canon/` 文件或常驻说明的评审按排队顺序跑，这样 D-81 的小评审能看到前一次的结果。

代码在 `landed-queue.ts`（runLandedReviews、nextOrRelease）、`landed.ts`（slots 传进 limits，重复评审也走 runReviews 占名额）和 `config-keys.ts`。架构总览顺手补上 BR-2486 的后台删 worktree（C-555 合入后评审留下的提示）。

## 陷阱和假设

`#220` 里第 1、2、5、6 点在改动前已经成立：意见按身份在一个写事务里记账（recordFindings），每次评审各自用事务改自己那一行，`after-land --wait` 只等自己那次合入的评审，事件带着 `landed`。重叠按文件判断，比较保守：都改了 architecture.md 的两次评审也会按顺序跑。

## 教训

无
