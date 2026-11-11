---
id: C-455
title: The incremental rule review lists the lines each changed document adds,
  so already-reviewed text is not judged as new (#178)
status: open
rules:
  - BR-2405
  - BR-2396
  - BR-2359
---

## 为什么

#178：C-447 给规则评审加的 `restatement` 标准说，不在 `# Lines added or changed in this landing` 里的改动文档是新的、每一行都算新行；但增量评审（BR-2396）不附这一段。于是每次增量评审时，已经通过完整评审、main 上已有的改动规则或决策看起来整篇都是新行，里面原有的复述可能拦住无关的改动，违背 D-84。

## 要改什么

- 合入的增量评审也附上改动文档这次新增或改动的行（`scope.added`），不附文字判定的候选（BR-2405、BR-2396）。
- BR-2359 加一句指向 BR-2396：小评审的领域正文和索引只含改动文档和新文档，是例外（C-444 留下的评审意见）。
- 测试：改动 main 上已有规则时，增量评审的提示里有这一段且只列新行、没有候选段；新建的规则没有这一段。

## 教训

无。

## 任务

- [x] 增量评审附新行
- [x] 规则 BR-2405、BR-2396 和测试
