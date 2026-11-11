---
id: C-457
title: canon-design's concurrency lens points to canon-triage's criterion
  instead of restating it (#182)
status: open
rules: []
---

## 为什么

C-454 合入时重复评审的提示（没拦）：canon-design 并发那一行“rarer ones are known limits unless they lose data”是 canon-triage 第 2 节判据的缩写，而且按频率判断、只写了丢数据一个例外，和判据（正常操作会不会引出它，例外是丢数据、安全、违背承诺）不一致；下游 `canon update` 的重复评审也可能拦它（#182）。

## 要改什么

删掉这一行后半句：同一文件第 3 节已经让每个场景按 canon-triage 第 2 节的判据判断，并发场景也在其中。不改规则。

## 教训

无

## 任务

- [x] 改 canon-design 并发一行，`canon work review` 通过
