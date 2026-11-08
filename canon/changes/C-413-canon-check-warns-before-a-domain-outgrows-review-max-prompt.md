---
id: C-413
title: canon check warns before a domain outgrows review_max_prompt_kb, and the
  refusal does not suggest a subdomain split when the top README is the large
  part
status: done
rules:
  - BR-2375
  - BR-2359
passes:
  BR-2359: 9f2374e437c1b3db test
  BR-2375: 48858ac72f502f6f test
---

## 为什么

#145：一个领域的规则评审提示超过 `review_max_prompt_kb` 时，项目要等改它的变更被拒（`canon work review` 退出码 4，或合入被拒）才知道，之后这个领域的所有变更都被挡住，只能调大预算。大小是 canon 内部装箱的结果，从外面估不出来。实例（zhushenkongjian）：`dungeon/hud` 的变更被拒，最小一块 130 KB，是 `dungeon` 自己的 README 和列表，而拒绝信息建议“拆成子领域”，拆了缩不小它。

复现（一次性夹具）：预算 60 KB，顶层领域 `dungeon` 的 README 79 KB、一条很短的规则：`canon check` 输出 `ok`，什么也没说；评审的提示计算对这个领域的任何改动都拒绝，信息写“拆成子领域”。

## 要改什么

现在：只有变更被拒时才知道预算不够；README 和列表是大头时，补救办法照样写拆子领域。

之后：

- `canon check` 对每个顶层领域按拒绝时同一套大小算最小一次提示的三部分（改动文档按 0，因为还没有改动；固定部分；领域那一块），达到预算 80% 就在标准错误输出一行提示，写明领域和三部分的大小，不算发现，不改退出码和标准输出（新规则 BR-2375，决策 D-76）。
- 顶层领域自己的 README 连同列表占领域那一块一半以上时，拒绝信息和提示都说缩短这份 README 或调大预算，并说拆子领域缩不小它；否则照旧（BR-2359 改补救办法的选法和一个例子）。

不在范围内：`canon work test` 转发这条提示；按改动文档的典型大小估；提示达到预算时拒绝合入。

## 教训

无

## 任务

- [x] 复现并在 #145 留言
- [x] 新增 BR-2375、改 BR-2359，写决策 D-76（proposed）
- [x] 测试：按规则编号命名
- [x] 实现：评审提示的大小计算抽成两处共用的函数，`canon check` 输出提示
