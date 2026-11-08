---
id: C-431
title: Shipped skills state each instruction once so canon update passes the
  duplicate review (#159)
status: open
rules: []
---

## 为什么

#159：`canon update` 装入新版 skill 内容时，重复审查（BR-2143）发现三处重复，更新无法合入。

## 要改什么

三处各只留一份：canon-parallel 的后台工作说明留 §3，第 10 条只留停止动作；交接命令留在 canon-triage，canon-parallel §2 只指向它；“继续做不依赖答案的工作”留在 canon-rules §5，canon-domains §10 指向它。不改规则，不改审查门。

## 教训

无

## 任务

- [x] 改三处 skill 文字，`canon work review` 通过
