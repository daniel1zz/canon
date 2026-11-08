---
id: C-401
title: A lander that was itself frozen does not abandon its peers (#138)
status: open
rules: [BR-2044]
---

## 为什么

issue #138：电脑睡眠后所有排队条目的心跳都过期，第一个醒来的合入者把其余（进程都还活着的）合入者全部标成放弃，还排到它们前面，BR-2020 的顺序被破坏。进程探测只抓得到已死的进程。

## 要改什么

tryTurn 里，自己上一次心跳超过掉线时间的查询者只刷新自己的心跳、不做心跳过期的清扫（批里的组长心跳判断同理）；进程已不在的照旧作废。BR-2044 加规则文字和两侧例子，测试按 BR-2044 命名。批候选 `batchCandidates` 只是不把心跳过期的条目拉进批，不放弃任何人，不改；`settleLocked` 由信号处理调用，不是轮询，不改。


## 教训

无

## 任务

- [x] 改 tryTurn、BR-2044、测试
