---
id: C-469
title: A reference becomes suspect when the document it names changes behaviour,
  until its author confirms it (C-464 D)
status: done
rules:
  - BR-2423
  - BR-2424
  - BR-2425
  - BR-2426
  - BR-2427
  - BR-2428
  - BR-2429
plan: C-464
steps:
  - D
passes:
  BR-2423: 780cfc62fd9ee7f4 test
  BR-2424: ccb3610faa389dfd test
  BR-2425: 9e5f3a5141fe40f0 test
  BR-2426: a6370e2489dd842c test
  BR-2427: df9049efb0452fe8 test
  BR-2428: a8cb7aff6fb9de3d test
  BR-2429: aa3bcfff71ae3bec test
---

## 为什么

C-464 的 D 步（D-90 方案 4）：规则或决策的正文点名别的规则或决策，被点名的那份的行为改了，点名它的这份可能已经对不上，却没人知道。要让这种引用在写的时候就被看到，验收（G 步）能要求零可疑，所以结果必须在任何提交上都能确定地算出来。

## 要改什么

- D-95（proposed，不接受；E 步接受 D-90）：复核记在引用方 front matter 的 `links` 里；没记的引用按 git 历史算基准；比较了只用历史加 trailer、一次补齐全部记录、共享文件或协调数据库、旁边另放记录文件，附耗时和现有可疑引用的数量。
- 新子领域 knowledge/links（`src/knowledge/links`）：BR-2423 引用、指纹和可疑；BR-2424 没记录时的历史基准；BR-2425 `canon links confirm` 和 `links` 记录；BR-2426 `canon check` 报 `link-stale`；BR-2427 `canon links list`；BR-2428 `canon context` 的 `# References`；BR-2429 `canon brief` 的提示。
- 规则和决策的 front matter 多一个 `links`（读取、格式错误报 `file-invalid`）；`links` 是 canon 保留的字段名。
- `canon context`：在 E 步也会改的相关文档提示之后加一小段调用（只加 `# References` 一节，不碰 related.ts）。
- 架构总览：`canon/` 文档树的数据和代码列表写上 `links` 和 `src/knowledge/links`；knowledge/check 的 README 写上 `link-stale`。
- 不在范围内：可疑引用不让 `canon check` 或合入失败（D-89）；验收要求零可疑是 G 步；现有的 584 条可疑引用不在这里复核。

## 陷阱和假设

- 历史基准沿第一父提交链算，按合入的先后，不是写的先后：没记录的引用，A 在变更里改了行为、B 同时在 main 上改了并先合入，会被当成复核过（D-95 后果里写明）。用 `canon links confirm` 记录的引用没有这个问题。
- `canon context <规则或决策>` 和 `canon brief` 每次多读一遍历史（canon 约 0.15 秒，zhushenkongjian 约 0.3 秒）；以后太慢再按 git 对象编号加缓存。
- 浅克隆只看得到它有的那段历史。

## 教训

无

## 任务

- [x] D-95 和 BR-2423 到 BR-2429
- [x] `src/knowledge/links`：引用、指纹、历史基准、`canon links list|confirm`
- [x] `canon context`、`canon brief`、`canon check` 接上
- [x] 测试 `src/knowledge/links/links.test.ts`
