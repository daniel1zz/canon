---
id: C-445
title: A second canon work land started while the first is still starting up
  follows it instead of starting another landing (#172)
status: done
rules:
  - BR-2392
passes:
  BR-2390: 1e413a5035d79394 test
  BR-2392: 5c074ea2aed5c59f test
---

## 为什么

#172（合入后代码评审提出）：C-438 让合入在后台跑，`canon work land` 靠这个 worktree 最近一条 `land.start` 判断有没有合入在跑。但 `land.start` 要等后台进程启动、读完配置才记下。在这段时间里再运行一次 `canon work land`（两个会话同时运行，或者前台刚脱离就重跑），它看不到正在启动的那次，于是又开一次合入：同一个 worktree 两次合入同时排队，第二次的结果覆盖或打乱第一次。用两个同时启动的 `canon work land` 能稳定复现：事件表里有两条 `land.start`。

## 要改什么

- 开始后台合入前，在一个写事务里先判断有没有合入在启动、在跑或结果没人看到，没有才记下 `land.spawn`（带 `run` 目录和开始它的进程），并在同一事务里决定；后台进程起来后把它的进程号写进 `run` 目录的 `pid` 文件。
- 再运行时，最近一条 `land.spawn` 之后没有同一个 `run` 的 `land.start`、没写退出码，而且合入进程还在（有 `pid` 文件时）或开始它的 `canon work land` 还在（没有时）→ 跟随它而不是另开。开始它的进程在启动合入前就死了 → 不算在启动，照常开新的合入（不留下要等很久的空记录）。
- 规则：改 BR-2392，加上启动中的情况和两个例子。
- 不改：`--stop` 的行为、跟随和脱离的规则（BR-2390、BR-2391）、合入本身的排队。

## 教训

无

## 任务

- [x] `land.spawn` 记录和判断放进同一个写事务，后台进程写 `pid` 文件
- [x] 再运行时识别启动中的合入并跟随
- [x] BR-2392 改写，加例子
- [x] 测试：BR-2392 两个同时启动只开一次合入；脱离后马上重跑跟随启动中的合入；开始者先死不等；land.start 前结束的结果照样报出
- [x] BR-2390 写明 `land.spawn` 和 `pid` 文件
