---
id: C-454
title: Shipped skills state each criterion once, so canon update passes the
  duplicate review (#182)
status: open
rules: []
---

## 为什么

#182：下游项目 `canon update` 装入的 skill 文字被重复评审（BR-2143）拦下：“正常操作会不会引出它”这条判据在 canon-triage、canon-diagnose、canon-design 三处几乎逐字重复；canon-parallel 的“合入前测试、不跑全量”重复了 canon-test 第 6 节。下游项目改不了这些文件（改了下次 `canon update` 要 `--force`）。

## 要改什么

判据只在 canon-triage 第 2 节写全；canon-diagnose 第 2 阶段和 canon-design 第 3 节改成按 canon-triage 的判据判断，只留各自的处理（不当作这个 bug 修 / 写进决策的后果或规则一行）。canon-parallel 的“合入前测试”指向 canon-test 第 6 节，只留没有 `canon work test` 时逐个文件运行的部分。不改规则，不改评审门。

## 陷阱和假设

canon 自己合入时，重复评审的提示只带改动过的 skill 的全文，没改动的 skill 只带 description（BR-2143）；所以只改一个 skill 的合入看不到它和另一个 skill 正文的重复，而 `canon update` 一次改动全部 skill，下游评审能看到。

## 教训

- canon 自己的合入只把改动过的 skill 全文放进重复评审，看不到和其他 skill 正文的重复（C-323 只改 canon-parallel，看不到 canon-test 第 6 节）；C-284 三处同时改动、全文都在提示里，评审仍判 ok，是模型判断前后不一致 → 待负责人确认是否固化（补上要改 BR-2143 的含义或新增机制，见报告）

## 任务

- [x] 三处 skill 文字只留一份，`canon work review` 通过
