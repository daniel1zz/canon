---
id: C-415
title: A plan names the release it belongs to, and canon release status shows
  its progress next to the rule counts
status: open
rules:
  - BR-2328
  - BR-2333
  - BR-2386
  - BR-2335
---

## 为什么

#146 的第三片，C-412 已合入，是这一片的基础；规则和决策见 BR-2369 到 BR-2374、D-77，版本见 D-61。

#146 的起因是 `canon release status` 对按步骤写规则的版本显示“规划中 0 已通过 378”，读起来像做完了。C-412 给了 `canon plan status`，但版本的视图仍然不知道计划：负责人看版本进度时看不到计划做了多少。

## 要改什么

- 计划变更的 front matter 可选 `release: R-n`，表示这个计划属于哪个版本（键名和规则上的 `release` 一致，指向不存在的版本报 `ref-dangling`，和 BR-2321 一样不存在的版本引用不通过）。已发布的版本不许再有新计划标它（和 BR-2326 对规则的要求一致，由决策写明）。
- `canon release status`（带编号和不带编号）在版本的规则数量之后，写标着它的计划的进度：`计划 C-n 已完成 21/51 (41%)`；`--json` 多一个 `plans` 数组。没有计划标着这个版本时输出和现在完全一样（BR-2328、BR-2329 的例子不变）。
- 要先写一条决定：已发布版本的计划标签要不要冻结，`canon release ship` 要不要要求标着它的计划全部完成。倾向：`ship` 要求标着它的计划所有步骤已完成（和要求规则全部已通过一样），需要一个决策写明理由；如果这里有真正的取舍，记成 proposed 决策，不替负责人定。
- 不做：改计划的格式；从规则推出计划；`canon plan status` 的输出。

## 教训

无

## 任务

- [x] 决策 D-79（负责人 2026-11-09 选了“要求全部完成（推荐）”，canon human #13）
- [x] 规则、测试、实现：BR-2386（新）、BR-2328、BR-2333
- [x] `canon release status` 原有的测试不改动仍然通过
