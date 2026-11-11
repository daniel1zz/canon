---
id: C-468
title: Related documents are ranked by references both ways, bigram text and
  shared names, in canon context, the edit hook and search (C-464 E)
status: done
rules:
  - BR-2387
  - BR-2421
  - BR-2422
  - BR-2402
  - BR-2073
  - BR-2215
  - BR-2214
plan: C-464
steps:
  - E
passes:
  BR-2073: 5bc85b9f0b4d6e18 test
  BR-2214: 3453af60cee48747 test
  BR-2215: 61bb8397c1d2984d test
  BR-2387: cf6f536d66a27aa1 test
  BR-2402: 10cd341a593340c5 test
  BR-2421: e13a4caf5e9ec3b3 test
  BR-2422: 5a62f126bf0bec96 test
---

## 为什么

C-464 的 E 步（D-90）：评审在迭代中不再拦截（D-89），文档之间的问题要在写的时候冒出来。现在的相关文档提示（BR-2387）只看其他顶层领域、只看共用名字，而考题里 76% 的配对在同一领域内，关系图（含反向引用）是最强的单一信号；`canon search` 逐字包含，换个说法就搜不到。D-90 的实测：前 10 名召回 BM25 44%、共用名字 43%、关系图 60%、三者融合 64%。

## 要改什么

- 接受 D-90。
- BR-2387 改写：`canon context <规则或决策>` 和 `canon work review` 列出和它最相关的 10 份文档，引用（一跳、两跳，双向）、汉字二元组 BM25 全文、共用名字三种排名按倒数排名融合（k = 60），同领域也列，每份带理由和第一句重叠的句子。
- BR-2421（新）：`canon restatements --hook` 编辑规则或决策后在同一行 JSON 里列出前 5 份相关文档，不调模型；BR-2402 的“没有复述时什么也不输出”相应改为不写复述的说明。
- BR-2422（新）：`canon search` 的词不被逐字包含时，含它超过一半二元组的文档也算命中，逐字包含的排在前面；BR-2073、BR-2215 相应说明。
- 代码：`src/knowledge/query/bigrams.ts`（切词和 BM25）、`related.ts`（融合排序）、`query.ts`（搜索）、`commands.ts`；`src/knowledge/check/restatement/{work,commands}.ts`（hook 拿到被写的文档后再算相关文档）；`src/knowledge/review/preview.ts`（换成新的排序）。
- `canon/architecture.md` 和 `knowledge/query` 的 README 写明相关文档的来源。
- 不在范围内：F 步的模型挑选、D 步的引用指纹。

## 陷阱和假设

- 候选沿用 related.ts 原来的“活的”定义：没有作废的规则和已接受的决策；proposed 的决策不列。
- 全文排名几乎让任何两份有共同词的文档都相关，所以不再有“还有几份”那一行；`#` 开头的小标题行不进全文，否则每份规则都因 `## 规则`、`## 例子` 相关。
- 实测（本仓库 962 份文档、474 份候选）：hook 整体从约 0.26 秒到约 0.34 秒，排序约 80 毫秒（建索引约 60、单份约 20），不缓存语料。

## 教训

无

## 任务

- [x] 接受 D-90，改写 BR-2387，新增 BR-2421、BR-2422，改 BR-2402、BR-2073、BR-2215
- [x] 融合排序、hook、搜索的代码和测试
- [x] 架构总览和领域 README
