---
id: C-294
title: "D-38 revised after review: one push deadline, known limits stated"
status: open
rules: [BR-2259, BR-2260]
---

## 为什么

独立评审（review-D35-D38-D40.md 的 D-38 一节）对 D-38 提了四条。2026-11-04 负责人选了“D-38 推送和 sync (推荐)”，即修订 D-38。逐条对照代码和事件表（`.git/canon/state.db`，2026-11-04 查询：`push.ok` 53 条、`push.fail` 5 条、`sync.*` 0 条）后：

- 第 3 条（最坏等待是 2 倍）属实，而且由正常操作引出：远端挂住时，推送等满 `remote_timeout_seconds`，推送被拒后的 fetch 又等满一次。修。今天 GitHub 的 500 是推送立刻失败、下次合入补推，没有挂住，所以只有等待时间这一条有代码改动。
- 第 1 条（`canon sync` 在 `floor_timing: before` 下带进没测过的提交）：提交只能来自本机以外的人往远端 main 写（网页编辑、PR 合并），而 product.md 的“不做的事”排除了多台电脑同时开发，`sync` 一次也没运行过。需要不正常的配置才出现，记为已知限制。
- 第 2 条（备份分支加只在通过后推 main）：为从没出现过的情形（远端 main 分叉）加一套新机制，且本来的方案 2 已因“main 红时远端落后”被否决；不改，把分叉记为已知限制。
- 第 4 条：默认 fetch refspec 由 `git remote add` 自带，没有它是不正常的配置；并发 fetch 抢锁最多留下一条会在下次推送后消失的假 `push.fail`，不丢数据。都记为已知限制，并把背景里的措辞改准。

## 要改什么

- `src/work/remote/remote.ts`：推送和推送被拒后的 fetch 共用一个 `remote_timeout_seconds`，剩余时间用完就不再 fetch。
- BR-2260 补一条规则和例子（总等待不超过 `remote_timeout_seconds`）；BR-2259 把“最多等”的范围写准。
- D-38 就地修订（它还是 proposed）：改背景里没依据的一句，更正等待时间，在后果里写四条已知限制。

## 陷阱和假设

依据 D-54：`canon sync` 一次也没运行过，`floor_timing: before` 下它带进没测过提交的限制，等真有人用它、真出现外部提交时再重新打开。

## 教训

无

## 任务

- [x] 失败的测试、修复、规则和 D-38 修订
