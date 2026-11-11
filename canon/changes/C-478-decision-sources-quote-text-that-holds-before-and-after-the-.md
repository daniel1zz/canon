---
id: C-478
title: Decision sources quote text that holds before and after the rule review
  moves after landing
status: open
rules: []
---

## 为什么

C-475（C-464 的 B 步前一半）把规则评审挪到合入之后，改写了 `src/work/land/checks/steps.ts` 和几条评审规则。D-21、D-48、D-49、D-70、D-84、D-86、D-89、D-97 的来源引文引的是这些文件里会被改掉的原文，C-475 一合入它们就对不上（`source-quote-missing`）。在 C-475 里一起改这八份决策，改动文档会超过旧版 canon 合入时评审的提示预算，所以先单独合入。

## 要改什么

- 八份决策各自那一条来源引文，改成在 main 现在的文字和 C-475 改后的文字里都有、说的是同一件事的句子；决策的正文和结论不变。
- 不改规则，不改代码。

## 陷阱和假设

- 新引文已在 main 和 C-475 的 worktree 里逐条核对过都存在；D-86 改引 BR-2057，B2 对 BR-2057 的改写保留了被引的那句。

## 教训

无

## 任务

- [x] 八份决策的来源引文改成评审挪动前后都成立的文字
