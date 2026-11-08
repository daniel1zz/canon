---
id: C-425
title: A landing tests the test files its rebase merged main's edits into and
  records their reports, instead of refusing them as unreported (#152)
status: open
rules: []
---

## 为什么

#152：变更 A 改了某条规则的测试文件并跑过 `canon work test`，排队期间另一个也改了这个文件的变更先合入。A 合入时 rebase 把两边的改动合在一起，文件内容变了，没有报告，`canon check` 报 `test-report-missing` 和 `rule-untested`，A 被拒、回到队尾。可是合入流程里没有任何一步会产出这份报告，只有 worker 自己 rebase、重跑、再排队才行。zhushenkongjian 一小时里有两个变更（C-323、C-342）这样被拒。

复现：本变更的测试 `BR-2381: the landing tests the merged file ...` 在修复前失败（被拒），修复后通过。

## 要改什么

- 新规则 BR-2381：rebase 之后、`canon check` 之前，对本变更测过、rebase 又改了内容、还没有报告的测试文件，合入自己跑一次，记下报告；失败就以 `check` 拒绝，写明文件和输出。
- 没有选让 floor 的报告当证据：floor 在 `canon check` 之后才跑，`floor_timing: after` 时更是在合入之后，没法给这一步当证据；自己跑一个文件只多几秒，证据仍然是“这个文件、这份内容的报告”，BR-2344 的含义不变。
- 不做：本变更从没测过的文件仍然拒绝；#154（同一个 diff 重复排队）另算。

## 教训

无

## 任务

- [x] BR-2381
- [x] 测试（修复前两条失败、修复后通过）
- [x] 实现
