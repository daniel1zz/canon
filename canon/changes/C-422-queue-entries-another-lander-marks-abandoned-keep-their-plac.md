---
id: C-422
title: Queue entries another lander marks abandoned keep their place for the
  keep window
status: open
rules: []
---

## 为什么

issue #148 的后续。D-75 让超时和被信号终止的合入保留排队位置，但合入者被 `kill -9` 杀掉、或心跳停了时，没有处理函数运行，条目要等别的合入者发现后标为 `abandoned`，这样的条目没有 `keep_until`，重新合入排到队尾。zhushenkongjian 的协调数据库实测：停止的合入里 `failed/killed` 54、`failed/timeout` 12、`abandoned` 13（`no heartbeat` 12、`lander process gone` 1），约 16% 的停止仍然失去位置，等待最久的变更最容易碰到。

## 要改什么

别的合入者把条目标为放弃时（进程不在、心跳过期），写下 `keep_until` = 最后一次心跳加 `land_keep_place_minutes`（0 表示不保留，时间已过也不保留），保持原有的进程归属检查。同一个 worktree、同一个变更在这之前重新合入，拿回原来那一行，`queue.enter` 带 `kept_after: abandoned`。放弃时记 `queue.abandon` 事件，`canon stats --since` 把它和回到保留位置的次数算进“停止等待”一行。新增 BR-2380，更新 BR-2368 的排除项、BR-2155 的统计行和 D-75 的相关说明。不改批的组成，不改心跳间隔和检测时机。

## 陷阱和假设

- 同一个 worktree 的下一次合入自己发现上一次的合入者已死而放弃它的条目（BR-2309）也走同一个保留，不然 `kill -9` 后立刻重跑反而排到队尾。
- 保留时间从最后一次心跳算起，所以发现得晚的条目剩下的时间少。

## 教训

无

## 任务

- [ ] 先写失败的测试：进程不在、心跳过期的条目被别人放弃后重新合入，现在排到队尾
- [ ] 放弃时写 keep_until 和 queue.abandon，重新合入拿回条目，stats 计数
- [ ] BR-2380、BR-2368、BR-2155、D-75
